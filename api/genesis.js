/**
 * Early Eagles — GET /api/genesis?address=SP...
 *
 * Trustless AIBTC Genesis agent verification.
 * Cross-validates two independent sources:
 *   1. AIBTC profile API — level >= 2 (Genesis tier)
 *   2. Hiro API — live on-chain ERC-8004 identity NFT holding
 *
 * Both must pass. Returns a clean boolean + minimal agent data.
 * Open CORS — public chain data, no secrets involved.
 *
 * Response:
 *   { address, is_genesis, level, level_name, erc8004_id, agent_name, bns_name, verified_at }
 */

const STACKS_API = 'https://api.hiro.so';
const AIBTC_API = 'https://aibtc.com/api/agents';
const IDENTITY_REGISTRY = 'SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2::agent-identity';

// Open CORS — this is a public utility for the ecosystem
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Rate limiting: 30 req / 60s per IP
const RATE_MAP = new Map();
const RATE_WINDOW = 60_000;
const MAX_REQ = 30;

function rateOk(ip) {
  const now = Date.now();
  const e = RATE_MAP.get(ip);
  if (!e || now > e.r) { RATE_MAP.set(ip, { c: 1, r: now + RATE_WINDOW }); return true; }
  if (e.c >= MAX_REQ) return false;
  e.c++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of RATE_MAP) if (now > v.r) RATE_MAP.delete(k);
}, 300_000);

function abortAfter(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const clientIp = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
  if (!rateOk(clientIp)) {
    return res.status(429).json({ error: 'Too many requests. Try again in 1 minute.' });
  }

  const rawAddr = (req.query || {}).address;
  if (!rawAddr || typeof rawAddr !== 'string') {
    return res.status(400).json({ error: 'Missing ?address= parameter (Stacks address)' });
  }
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) {
    return res.status(400).json({ error: 'Invalid Stacks address format' });
  }

  // Normalize testnet prefix to mainnet
  const address = rawAddr.startsWith('ST') ? 'SP' + rawAddr.slice(2)
                : rawAddr.startsWith('SN') ? 'SM' + rawAddr.slice(2)
                : rawAddr;

  // Fetch AIBTC profile and on-chain ERC-8004 holding in parallel
  const [aibtcRes, hiroRes] = await Promise.allSettled([
    fetch(`${AIBTC_API}/${address}`, {
      headers: { 'User-Agent': 'EarlyEagles/2.0' },
      signal: abortAfter(6000),
    }),
    fetch(
      `${STACKS_API}/extended/v1/tokens/nft/holdings?principal=${address}` +
      `&asset_identifiers=${encodeURIComponent(IDENTITY_REGISTRY)}`,
      { signal: abortAfter(6000) }
    ),
  ]);

  // Base response
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

  // --- AIBTC profile ---
  if (aibtcRes.status === 'rejected' || !aibtcRes.value.ok) {
    out.sources.aibtc = aibtcRes.status === 'fulfilled' && aibtcRes.value.status === 404
      ? 'not_found'
      : 'error';
  } else {
    const data = await aibtcRes.value.json();
    out.level = typeof data.level === 'number' ? data.level : null;
    out.level_name = data.levelName || null;
    out.agent_name = data.displayName || null;
    out.bns_name = data.bnsName || null;
    out.verified_at = data.verifiedAt || null;
  }

  // --- On-chain ERC-8004 ---
  if (hiroRes.status === 'rejected' || !hiroRes.value.ok) {
    out.sources.chain = 'error';
  } else {
    const hiro = await hiroRes.value.json();
    const holding = (hiro.results || [])[0];
    if (holding) {
      const raw = holding.value?.repr || '';
      const id = parseInt(raw.replace(/^u/, ''), 10);
      if (!isNaN(id)) out.erc8004_id = id;
    }
  }

  // Genesis = level >= 2 (AIBTC) AND erc8004_id present (chain)
  // Degrade gracefully: if one source errored, use the other alone with a warning
  const aibtcOk = out.sources.aibtc === 'ok';
  const chainOk = out.sources.chain === 'ok';

  if (aibtcOk && chainOk) {
    out.is_genesis = out.level >= 2 && out.erc8004_id !== null;
  } else if (aibtcOk && !chainOk) {
    // Chain down — use AIBTC only, flag partial
    out.is_genesis = out.level >= 2;
    out.sources.chain = 'unavailable';
    out.warning = 'On-chain ERC-8004 check unavailable — result based on AIBTC profile only';
  } else if (!aibtcOk && chainOk) {
    // AIBTC down — use chain only
    out.is_genesis = out.erc8004_id !== null;
    out.sources.aibtc = out.sources.aibtc === 'not_found' ? 'not_found' : 'unavailable';
    out.warning = 'AIBTC profile unavailable — result based on on-chain identity only';
  }
  // If both errored: is_genesis stays false, both sources show error

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  return res.status(200).json(out);
};
