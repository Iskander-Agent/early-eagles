/**
 * Early Eagles — merged verification handler
 *
 * GET /api/genesis?address=SP...
 *   Trustless AIBTC Genesis agent verification.
 *   Cross-validates AIBTC profile (level ≥ 2) + on-chain ERC-8004 identity NFT.
 *   Response: { address, is_genesis, level, level_name, erc8004_id, agent_name, bns_name, verified_at, sources }
 *
 * GET /api/holder?address=SP...
 *   Returns whether an address holds an Early Eagle.
 *   Response: { address, holds_eagle, token_ids, count, verified_at }
 */

const STACKS_API        = 'https://api.hiro.so';
const AIBTC_API         = 'https://aibtc.com/api/agents';
const IDENTITY_REGISTRY = 'SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2::agent-identity';
const EAGLE_ASSET       = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2.early-eagles-v2::early-eagles';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Shared rate-limit map (60s windows, keyed by ip+route)
const RATE_MAP = new Map();
function rateOk(key, max) {
  const now = Date.now();
  const e = RATE_MAP.get(key);
  if (!e || now > e.r) { RATE_MAP.set(key, { c: 1, r: now + 60_000 }); return true; }
  if (e.c >= max) return false;
  e.c++;
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of RATE_MAP) if (now > v.r) RATE_MAP.delete(k); }, 300_000);

function abort(ms) { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; }

function normalizeAddress(raw) {
  return raw.startsWith('ST') ? 'SP' + raw.slice(2)
       : raw.startsWith('SN') ? 'SM' + raw.slice(2)
       : raw;
}

// ── /api/genesis handler ──────────────────────────────────────────────────────

async function handleGenesis(req, res) {
  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
  if (!rateOk(ip + ':genesis', 30)) {
    return res.status(429).json({ error: 'Too many requests. Try again in 1 minute.' });
  }

  const rawAddr = (req.query || {}).address;
  if (!rawAddr || typeof rawAddr !== 'string') {
    return res.status(400).json({ error: 'Missing ?address= parameter (Stacks address)' });
  }
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) {
    return res.status(400).json({ error: 'Invalid Stacks address format' });
  }

  const address = normalizeAddress(rawAddr);

  const [aibtcRes, hiroRes] = await Promise.allSettled([
    fetch(`${AIBTC_API}/${address}`, {
      headers: { 'User-Agent': 'EarlyEagles/2.0' },
      signal: abort(6000),
    }),
    fetch(
      `${STACKS_API}/extended/v1/tokens/nft/holdings?principal=${address}` +
      `&asset_identifiers=${encodeURIComponent(IDENTITY_REGISTRY)}`,
      { signal: abort(6000) }
    ),
  ]);

  const out = {
    address,
    is_genesis: false,
    level: null,
    level_name: null,
    erc8004_id: null,
    agent_name: null,
    bns_name: null,
    verified_at: null,
    sources: { aibtc: 'ok', chain: 'ok' },
  };

  if (aibtcRes.status === 'rejected' || !aibtcRes.value.ok) {
    out.sources.aibtc = aibtcRes.status === 'fulfilled' && aibtcRes.value.status === 404
      ? 'not_found' : 'error';
  } else {
    const data = await aibtcRes.value.json();
    out.level      = typeof data.level === 'number' ? data.level : null;
    out.level_name = data.levelName || null;
    out.agent_name = data.displayName || null;
    out.bns_name   = data.bnsName || null;
    out.verified_at = data.verifiedAt || null;
  }

  if (hiroRes.status === 'rejected' || !hiroRes.value.ok) {
    out.sources.chain = 'error';
  } else {
    const hiro = await hiroRes.value.json();
    const holding = (hiro.results || [])[0];
    if (holding) {
      const id = parseInt((holding.value?.repr || '').replace(/^u/, ''), 10);
      if (!isNaN(id)) out.erc8004_id = id;
    }
  }

  const aibtcOk = out.sources.aibtc === 'ok';
  const chainOk = out.sources.chain === 'ok';

  if (aibtcOk && chainOk) {
    out.is_genesis = out.level >= 2 && out.erc8004_id !== null;
  } else if (aibtcOk && !chainOk) {
    out.is_genesis = out.level >= 2;
    out.sources.chain = 'unavailable';
    out.warning = 'On-chain ERC-8004 check unavailable — result based on AIBTC profile only';
  } else if (!aibtcOk && chainOk) {
    out.is_genesis = out.erc8004_id !== null;
    out.sources.aibtc = out.sources.aibtc === 'not_found' ? 'not_found' : 'unavailable';
    out.warning = 'AIBTC profile unavailable — result based on on-chain identity only';
  }

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  return res.status(200).json(out);
}

// ── /api/holder handler ───────────────────────────────────────────────────────

const TIER_NAMES = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];
const ADMIN_ADDRESS = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2';
const NFT_CONTRACT  = 'early-eagles-v2';

async function fetchTier(tokenId) {
  const { hexToCV, cvToJSON } = await import('@stacks/transactions');
  const tokenIdHex = '0x01' + tokenId.toString(16).padStart(32, '0');
  const r = await fetch(
    `${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDRESS}/${NFT_CONTRACT}/get-traits`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: ADMIN_ADDRESS, arguments: [tokenIdHex] }),
      signal: abort(6000),
    }
  );
  if (!r.ok) return null;
  const data = await r.json();
  if (!data.okay || data.result === '0x09') return null;
  const json = cvToJSON(hexToCV(data.result));
  if (!json?.value?.value) return null;
  const tier = parseInt(json.value.value.tier?.value ?? '4', 10);
  return { token_id: tokenId, tier, tier_name: TIER_NAMES[tier] ?? 'Unknown' };
}

async function handleHolder(req, res) {
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!rateOk(ip + ':holder', 60)) return res.status(429).json({ error: 'Too many requests' });

  const rawAddr = (req.query || {}).address;
  if (!rawAddr) return res.status(400).json({ error: 'Missing ?address= parameter' });
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) return res.status(400).json({ error: 'Invalid Stacks address' });

  const address = normalizeAddress(rawAddr);

  try {
    const url = `${STACKS_API}/extended/v1/tokens/nft/holdings` +
      `?principal=${address}&asset_identifiers=${encodeURIComponent(EAGLE_ASSET)}&limit=50`;
    const hiroRes = await fetch(url, { signal: abort(6000) });
    if (!hiroRes.ok) throw new Error(`Hiro API ${hiroRes.status}`);

    const data = await hiroRes.json();
    const token_ids = (data.results || [])
      .map(h => { const id = parseInt((h.value?.repr || '').replace(/^u/, ''), 10); return isNaN(id) ? null : id; })
      .filter(id => id !== null);

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

    if (token_ids.length === 0) {
      return res.status(200).json({
        address,
        holds_eagle: false,
        token_ids: [],
        count: 0,
        tiers: [],
        highest_tier: null,
        highest_tier_name: null,
        verified_at: new Date().toISOString(),
      });
    }

    // Fetch tier for each held token in parallel
    const tierResults = await Promise.allSettled(token_ids.map(fetchTier));
    const tiers = tierResults
      .map(r => (r.status === 'fulfilled' ? r.value : null))
      .filter(Boolean);

    const highestTier = tiers.reduce((min, t) => (t.tier < min ? t.tier : min), 4);

    return res.status(200).json({
      address,
      holds_eagle: true,
      token_ids,
      count: token_ids.length,
      tiers,
      highest_tier: highestTier,
      highest_tier_name: TIER_NAMES[highestTier],
      verified_at: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(503).json({ error: 'Chain check failed', detail: e.message });
  }
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const path = (req.url || '').split('?')[0];

  if (path.endsWith('/genesis')) return handleGenesis(req, res);
  if (path.endsWith('/holder'))  return handleHolder(req, res);

  return res.status(404).json({ error: 'Not found' });
};
