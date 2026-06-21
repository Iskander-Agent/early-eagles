/**
 * Early Eagles — merged verification + attestation handler
 *
 * GET /api/genesis?address=SP...
 *   Trustless AIBTC Genesis agent verification.
 *   Cross-validates AIBTC profile (level ≥ 2) + on-chain ERC-8004 identity NFT.
 *   Response: { address, is_genesis, level, level_name, erc8004_id, agent_name, bns_name, verified_at, sources }
 *
 * GET /api/holder?address=SP...
 *   Returns whether an address holds an Early Eagle.
 *   Response: { address, holds_eagle, token_ids, count, verified_at }
 *
 * POST /api/attest
 *   Produces a verifiable attestation artifact signed by an Eagle holder.
 *   Body: { address, signature, message }
 *   Response: { id, attested_by, eagle_token_ids, message, message_hash, signature, timestamp, verify_url }
 */

const { publicKeyFromSignatureRsv, getAddressFromPublicKey, createMessageSignature, TransactionVersion } = require('@stacks/transactions');
const { sha256 } = require('@noble/hashes/sha256');

const STACKS_API        = 'https://api.hiro.so';
const AIBTC_API         = 'https://aibtc.com/api/agents';
const IDENTITY_REGISTRY = 'SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2::agent-identity';
const EAGLE_ASSET       = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2.early-eagles-v2::early-eagle';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

// ── /api/eligibility handler ─────────────────────────────────────────────────

const EAGLE_ADMIN   = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2';
const CONTRACT_NAME = 'early-eagles-v2';

async function checkAlreadyMinted(addr) {
  try {
    const r = await fetch(
      `${STACKS_API}/extended/v1/tokens/nft/holdings?principal=${addr}` +
      `&asset_identifiers=${encodeURIComponent(EAGLE_ADMIN + '.' + CONTRACT_NAME + '::early-eagle')}`,
      { signal: abort(5000) }
    );
    if (!r.ok) return null;
    return (await r.json()).results?.length > 0;
  } catch { return null; }
}

async function handleEligibility(req, res) {
  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
  if (!rateOk(ip + ':eligibility', 20)) return res.status(429).json({ error: 'Too many requests. Try again in 1 minute.' });

  const rawAddr = (req.query || {}).address;
  const rawBtc  = (req.query || {}).btc;
  if (!rawAddr || typeof rawAddr !== 'string') return res.status(400).json({ error: 'Missing ?address= parameter' });
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) return res.status(400).json({ error: 'Invalid Stacks address format' });

  const address = normalizeAddress(rawAddr);
  const btcHint = (rawBtc && /^bc1[a-z0-9]{25,87}$/.test(rawBtc)) ? rawBtc : null;

  const [apiRes, hiroRes, minted] = await Promise.allSettled([
    fetch(`${AIBTC_API}/${address}`, { headers: { 'User-Agent': 'EarlyEagles/2.0' }, signal: abort(5000) }),
    fetch(`${STACKS_API}/extended/v1/tokens/nft/holdings?principal=${address}&asset_identifiers=${encodeURIComponent(IDENTITY_REGISTRY)}`, { signal: abort(5000) }),
    checkAlreadyMinted(address),
  ]);

  const result = { address, eligible: false, reason: null, agent: null, alreadyMinted: minted.status === 'fulfilled' ? minted.value : null };

  if (hiroRes.status === 'rejected' || !hiroRes.value.ok) { result.reason = 'Identity lookup failed — try again shortly'; return res.status(200).json(result); }
  const hiro = await hiroRes.value.json();
  const holding = (hiro.results || [])[0];
  const agentId = holding ? parseInt(holding.value.repr.replace(/^u/, ''), 10) : null;
  const resolvedAgentId = Number.isFinite(agentId) ? agentId : null;

  let data = null;
  if (apiRes.status === 'fulfilled' && apiRes.value.ok) {
    const raw = await apiRes.value.json();
    if (raw && typeof raw.level === 'number') data = raw;
  } else if (!btcHint) { result.reason = 'AIBTC lookup failed — try again shortly'; return res.status(200).json(result); }

  if (!data && btcHint) {
    try { const r = await fetch(`${AIBTC_API}/${btcHint}`, { headers: { 'User-Agent': 'EarlyEagles/2.0' }, signal: abort(5000) }); if (r.ok) { const d = await r.json(); if (d && typeof d.level === 'number') data = d; } } catch { /* ignore */ }
  }
  if (!data) { result.reason = 'Agent not found on AIBTC network'; return res.status(200).json(result); }

  const agent = data.agent || {};
  result.agent = { displayName: agent.displayName || null, bnsName: agent.bnsName || null, btcAddress: agent.btcAddress || null, level: data.level, levelName: data.levelName || 'Unknown' };
  if (data.level < 2) { result.reason = `Not a Genesis agent (current level: ${data.levelName || data.level})`; return res.status(200).json(result); }
  if (!resolvedAgentId && resolvedAgentId !== 0) { result.reason = 'No on-chain ERC-8004 identity found'; return res.status(200).json(result); }

  result.agent.agentId = resolvedAgentId;
  result.eligible = true;
  if (result.alreadyMinted) result.reason = 'Already minted — each agent can only mint once';
  return res.status(200).json(result);
}

// ── /api/recent-mints handler ─────────────────────────────────────────────────

const COLOR_NAMES = [
  'Azure', 'Sapphire', 'Amethyst', 'Fuchsia', 'Crimson', 'Scarlet', 'Ember',
  'Amber', 'Chartreuse', 'Jade', 'Forest', 'Teal',
  'Gold', 'Pearl', 'Negative', 'Thermal', 'X-Ray', 'Aurora', 'Psychedelic', 'Bitcoin', 'Shadow',
];

async function fetchRecentTraits(tokenId) {
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
  const t = json.value.value;
  const tier    = parseInt(t.tier?.value ?? '4', 10);
  const colorId = parseInt(t['color-id']?.value ?? '0', 10);
  return {
    token_id:    tokenId,
    display_name: t['display-name']?.value ?? `Eagle #${tokenId}`,
    tier,
    tier_name:   TIER_NAMES[tier]    ?? 'Common',
    color_id:    colorId,
    color_name:  COLOR_NAMES[colorId] ?? 'Unknown',
    minted_at:   parseInt(t['minted-at']?.value ?? '0', 10),
  };
}

async function handleRecentMints(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');

  const count = Math.min(Math.max(parseInt(req.query.count) || 3, 1), 10);

  try {
    const { hexToCV, cvToJSON } = await import('@stacks/transactions');

    const lastRes = await fetch(
      `${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDRESS}/${NFT_CONTRACT}/get-last-token-id`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: ADMIN_ADDRESS, arguments: [] }),
        signal: abort(6000),
      }
    );
    if (!lastRes.ok) return res.status(502).json({ error: 'contract read failed' });
    const lastData = await lastRes.json();
    if (!lastData.okay) return res.status(502).json({ error: 'contract read failed' });

    const lastCv = cvToJSON(hexToCV(lastData.result));
    // get-last-token-id returns (ok uint); cvToJSON shape: { value: { value: '30' } }
    const lastId = parseInt(lastCv?.value?.value ?? '-1', 10);
    if (isNaN(lastId) || lastId < 0) return res.status(200).json({ recent: [], total_minted: 0 });

    const ids = [];
    for (let i = lastId; i >= 0 && ids.length < count; i--) ids.push(i);

    const settled = await Promise.allSettled(ids.map(fetchRecentTraits));
    const recent  = settled.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);

    return res.status(200).json({ recent, last_id: lastId, total_minted: lastId + 1 });
  } catch (e) {
    return res.status(500).json({ error: 'failed to fetch recent mints', detail: e.message });
  }
}

// ── /api/attest handler (POST) ────────────────────────────────────────────────

const ATTEST_RATE_MAP = new Map();
function attestRateOk(ip) {
  const now = Date.now();
  const e = ATTEST_RATE_MAP.get(ip);
  if (!e || now > e.r) { ATTEST_RATE_MAP.set(ip, { c: 1, r: now + 60_000 }); return true; }
  if (e.c >= 5) return false;
  e.c++;
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of ATTEST_RATE_MAP) if (now > v.r) ATTEST_RATE_MAP.delete(k); }, 300_000);

function verifyNonceSignature(address, signature) {
  const bucket = Math.floor(Date.now() / 600_000);
  for (const b of [bucket, bucket - 1]) {
    const nonce = `EaglesNest:${address}:${b}`;
    const hashHex = Buffer.from(sha256(Buffer.from(nonce, 'utf8'))).toString('hex');
    try {
      const msgSig = createMessageSignature(signature);
      const pubKey = publicKeyFromSignatureRsv(hashHex, msgSig);
      const derived = getAddressFromPublicKey(pubKey.data, TransactionVersion.Mainnet);
      if (derived === address) return true;
    } catch { /* next */ }
  }
  return false;
}

async function handleAttest(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!attestRateOk(ip)) return res.status(429).json({ error: 'Rate limit exceeded' });

  const body = req.body || {};
  const { address: rawAddr, signature, message } = body;
  if (!rawAddr || !signature || !message) return res.status(400).json({ error: 'Missing address, signature, or message' });
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) return res.status(400).json({ error: 'Invalid Stacks address' });
  if (!/^[0-9a-fA-F]{130}$/.test(signature)) return res.status(400).json({ error: 'Invalid signature format' });
  if (typeof message !== 'string' || message.length > 1024) return res.status(400).json({ error: 'Message must be a string, max 1024 chars' });

  const address = rawAddr.startsWith('ST') ? 'SP' + rawAddr.slice(2) : rawAddr;

  if (!verifyNonceSignature(address, signature)) {
    return res.status(401).json({ error: 'Signature invalid or nonce expired' });
  }

  let eagle_token_ids = [];
  try {
    const url = `${STACKS_API}/extended/v1/tokens/nft/holdings?principal=${address}&asset_identifiers=${encodeURIComponent(EAGLE_ASSET)}`;
    const r = await fetch(url, { signal: abort(6000) });
    if (r.ok) {
      const d = await r.json();
      eagle_token_ids = (d.results || []).map(h => {
        const id = parseInt((h.value?.repr || '').replace(/^u/, ''), 10);
        return isNaN(id) ? null : id;
      }).filter(Boolean);
    }
  } catch { /* non-fatal */ }

  if (eagle_token_ids.length === 0) {
    return res.status(403).json({ error: 'Address does not hold an Early Eagle' });
  }

  const timestamp = new Date().toISOString();
  const message_hash = Buffer.from(sha256(Buffer.from(message, 'utf8'))).toString('hex');
  const id = Buffer.from(sha256(Buffer.from(`${address}:${message_hash}:${timestamp}`, 'utf8'))).toString('hex').slice(0, 16);

  return res.status(200).json({
    id,
    attested_by: address,
    eagle_token_ids,
    message,
    message_hash,
    signature,
    timestamp,
    verify_url: `https://early-eagles.vercel.app/api/holder?address=${address}`,
  });
}

// ── /api/utilities + /api/shuffle (merged from utilities.js) ─────────────────

const _fs   = require('fs');
const _path = require('path');

function handleShuffle(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).json({
    total: 420, method: 'random-at-mint',
    note: 'Tier and color are randomly drawn from remaining pool at mint time using crypto.randomInt.',
    distribution: {
      legendary: { count: 10,  colors: 10, note: '10 unique 1-of-1 colors' },
      epic:      { count: 60,  colors: 14, note: '8 hue x6 + 6 FX x2' },
      rare:      { count: 80,  colors: 14, note: '8 hue x9 + Pearl(2) Shadow(2) Neg(1) Thm(1) XR(1) IR(1)' },
      uncommon:  { count: 150, colors: 12, note: '12-13 of each color' },
      common:    { count: 120, colors: 12, note: '10 of each color' },
    },
  });
}

function handleUtilities(req, res) {
  let utilities;
  try {
    utilities = JSON.parse(_fs.readFileSync(_path.join(__dirname, '..', 'data', 'utilities.json'), 'utf8'));
  } catch (err) {
    return res.status(500).json({ error: 'Could not load utilities data' });
  }
  const { status } = req.query;
  const filtered  = status ? utilities.filter(u => u.status === status) : utilities;
  const live      = utilities.filter(u => u.status === 'live');
  const building  = utilities.filter(u => u.status === 'building');
  const planned   = utilities.filter(u => u.status === 'planned');
  const agentSummary = live.length > 0
    ? `Holding an Early Eagle currently unlocks: ${live.map(u => u.name).join(', ')}. Coming soon: ${building.map(u => u.name).join(', ')}.`
    : 'Utility integrations are in progress. Check back soon.';
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  return res.status(200).json({ total: utilities.length,
    counts: { live: live.length, building: building.length, planned: planned.length },
    agent_summary: agentSummary, utilities: filtered });
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  const path = (req.url || '').split('?')[0];

  // POST routes
  if (path.endsWith('/attest')) return handleAttest(req, res);

  // GET routes
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (path.endsWith('/genesis'))      return handleGenesis(req, res);
  if (path.endsWith('/holder'))       return handleHolder(req, res);
  if (path.endsWith('/eligibility'))  return handleEligibility(req, res);
  if (path.endsWith('/recent-mints')) return handleRecentMints(req, res);
  if (path.endsWith('/utilities'))    return handleUtilities(req, res);
  if (path.endsWith('/shuffle'))      return handleShuffle(req, res);

  return res.status(404).json({ error: 'Not found' });
};
