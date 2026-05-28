/**
 * Early Eagles — /api/nest  (handles 4 routes)
 *
 * GET  /api/nest?address=SP...               → challenge nonce to sign
 * POST /api/nest                             → verify signature, return tier
 * POST /api/nest/authorize                   → link a Telegram user to an Eagle
 * GET  /api/nest/check?telegram_user_id=...  → bot checks if user is authorized
 *
 * Nonce format: EaglesNest:<address>:<bucket>  (10-min windows)
 *   sign_hash = sha256(nonce)
 *   signature = signMessageHashRsv(privateKey, sign_hash)  [130-char RSV hex]
 *
 * KV storage (Vercel KV / Upstash) for owner delegation:
 *   nest:eagle:{token_id}  → telegram_user_id
 *   nest:tg:{telegram_id}  → eagle_token_id
 */

const { publicKeyFromSignatureRsv, getAddressFromPublicKey, createMessageSignature, TransactionVersion } = require('@stacks/transactions');
const { sha256 } = require('@noble/hashes/sha256');

const STACKS_API        = 'https://api.hiro.so';
const AIBTC_API         = 'https://aibtc.com/api/agents';
const IDENTITY_REGISTRY = 'SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2::agent-identity';
const EAGLE_ASSET       = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2.early-eagles-v2::early-eagles';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Rate limiting per-action
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
  return raw.startsWith('ST') ? 'SP' + raw.slice(2) : raw;
}

function nonceHash(address) {
  const bucket = Math.floor(Date.now() / 600_000);
  const nonce = `EaglesNest:${address}:${bucket}`;
  return { nonce, hash: Buffer.from(sha256(Buffer.from(nonce, 'utf8'))).toString('hex'), bucket };
}

function verifyNonceSignature(address, signature) {
  const bucket = Math.floor(Date.now() / 600_000);
  for (const b of [bucket, bucket - 1]) {
    const nonce = `EaglesNest:${address}:${b}`;
    const hashHex = Buffer.from(sha256(Buffer.from(nonce, 'utf8'))).toString('hex');
    try {
      const pubKey = publicKeyFromSignatureRsv(hashHex, createMessageSignature(signature));
      if (getAddressFromPublicKey(pubKey.data, TransactionVersion.Mainnet) === address) return true;
    } catch { /* try next bucket */ }
  }
  return false;
}

async function getEagleTokenIds(address) {
  const url = `${STACKS_API}/extended/v1/tokens/nft/holdings` +
    `?principal=${address}&asset_identifiers=${encodeURIComponent(EAGLE_ASSET)}&limit=50`;
  const r = await fetch(url, { signal: abort(6000) });
  if (!r.ok) throw new Error(`Hiro ${r.status}`);
  return ((await r.json()).results || [])
    .map(h => parseInt((h.value?.repr || '').replace(/^u/, ''), 10))
    .filter(id => !isNaN(id))
    .sort((a, b) => a - b);
}

// Lazy KV loader — only require @vercel/kv when KV env vars are present
function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try { return require('@vercel/kv').kv; } catch { return null; }
}

// ── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  const ip = req.headers['x-forwarded-for'] || 'unknown';
  const path = (req.url || '').split('?')[0];
  const isAuthorize = path.endsWith('/authorize');
  const isCheck     = path.endsWith('/check');

  // ── GET /api/nest/check?telegram_user_id=... ─────────────────────────────
  if (req.method === 'GET' && isCheck) {
    if (!rateOk(ip + ':check', 30)) return res.status(429).json({ authorized: false, reason: 'Too many requests' });
    const tg = String((req.query || {}).telegram_user_id || '');
    if (!tg || !/^\d+$/.test(tg)) {
      return res.status(400).json({ authorized: false, reason: 'Missing or invalid telegram_user_id (must be numeric)' });
    }
    const kv = getKv();
    if (!kv) return res.status(503).json({ authorized: false, reason: 'Owner delegation not yet configured. Contact the Eagles Nest admin.' });
    let eagle_token_id;
    try { eagle_token_id = await kv.get(`nest:tg:${tg}`); } catch {
      return res.status(503).json({ authorized: false, reason: 'Storage unavailable. Try again shortly.' });
    }
    if (eagle_token_id === null || eagle_token_id === undefined) {
      return res.status(200).json({ authorized: false, reason: 'Telegram user not linked to any Eagle. Eagle holder must call POST /api/nest/authorize first.' });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ authorized: true, eagle_token_id, tier: 'eagle' });
  }

  // ── GET /api/nest?address=... — challenge nonce ───────────────────────────
  if (req.method === 'GET') {
    if (!rateOk(ip + ':nonce', 60)) return res.status(429).json({ error: 'Too many requests' });
    const rawAddr = (req.query || {}).address;
    if (!rawAddr) return res.status(400).json({ error: 'Missing ?address= parameter' });
    if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) return res.status(400).json({ error: 'Invalid Stacks address' });
    const address = normalizeAddress(rawAddr);
    const { nonce, hash } = nonceHash(address);
    const expires_in = 600 - Math.floor((Date.now() % 600_000) / 1000);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      address, nonce, sign_hash: hash, expires_in_seconds: expires_in,
      instructions: [
        '1. sign_hash = sha256("EaglesNest:<address>:<bucket>")',
        '2. signature = signMessageHashRsv(privateKey, sign_hash)  [130-char RSV hex]',
        '3. POST /api/nest { address, signature }',
      ],
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── POST /api/nest/authorize — link Telegram account to Eagle ─────────────
  if (isAuthorize) {
    if (!rateOk(ip + ':authorize', 5)) return res.status(429).json({ error: 'Too many requests. Try again in 1 minute.' });
    const { address: rawAddr, signature, telegram_user_id } = req.body || {};
    if (!rawAddr || !signature || !telegram_user_id) {
      return res.status(400).json({ error: 'Missing required fields: address, signature, telegram_user_id' });
    }
    if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) return res.status(400).json({ error: 'Invalid Stacks address' });
    if (!/^[0-9a-fA-F]{130}$/.test(signature)) return res.status(400).json({ error: 'Invalid signature (expect 130-char RSV hex)' });
    if (!/^\d+$/.test(String(telegram_user_id))) return res.status(400).json({ error: 'telegram_user_id must be numeric' });

    const address = normalizeAddress(rawAddr);
    const tg = String(telegram_user_id);

    if (!verifyNonceSignature(address, signature)) {
      return res.status(401).json({ error: 'Signature invalid or nonce expired.', hint: 'GET /api/nest?address=<SP...> for a fresh nonce.' });
    }

    let token_ids;
    try { token_ids = await getEagleTokenIds(address); } catch {
      return res.status(503).json({ error: 'On-chain check failed. Try again shortly.' });
    }
    if (token_ids.length === 0) {
      return res.status(403).json({ error: 'Address holds no Early Eagles. Must hold ≥1 Eagle to authorize a Telegram account.' });
    }

    const eagle_token_id = token_ids[0]; // lowest token_id (already sorted)
    const kv = getKv();
    if (!kv) return res.status(503).json({ error: 'Owner delegation storage not yet configured. Contact the Eagles Nest admin.' });

    const eagleKey = `nest:eagle:${eagle_token_id}`;
    const tgKey    = `nest:tg:${tg}`;
    let evicted = null;
    try {
      const existing_tg = await kv.get(eagleKey);
      if (existing_tg && existing_tg !== tg) { evicted = existing_tg; await kv.del(`nest:tg:${existing_tg}`); }
      const existing_eagle = await kv.get(tgKey);
      if (existing_eagle !== null && existing_eagle !== eagle_token_id) { await kv.del(`nest:eagle:${existing_eagle}`); }
      await kv.set(eagleKey, tg);
      await kv.set(tgKey, eagle_token_id);
    } catch {
      return res.status(503).json({ error: 'Storage unavailable. Try again shortly.' });
    }

    const out = { success: true, eagle_token_id, telegram_user_id: tg, address, authorized_at: new Date().toISOString() };
    if (evicted) out.evicted_telegram_user_id = evicted;
    return res.status(200).json(out);
  }

  // ── POST /api/nest — verify signature, return tier ───────────────────────
  if (!rateOk(ip + ':verify', 10)) return res.status(429).json({ authorized: false, reason: 'Too many attempts' });

  const { address: rawAddr, signature } = req.body || {};
  if (!rawAddr || !signature) return res.status(400).json({ authorized: false, reason: 'Missing address or signature' });
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) return res.status(400).json({ authorized: false, reason: 'Invalid address' });
  if (!/^[0-9a-fA-F]{130}$/.test(signature)) return res.status(400).json({ authorized: false, reason: 'Invalid signature (expect 130-char RSV hex)' });

  const address = normalizeAddress(rawAddr);
  if (!verifyNonceSignature(address, signature)) {
    return res.status(401).json({ authorized: false, reason: 'Signature invalid or nonce expired. GET /api/nest?address=<SP...> for fresh nonce.' });
  }

  const [genesisRes, erc8004Res, eagleRes] = await Promise.allSettled([
    fetch(`${AIBTC_API}/${address}`, { headers: { 'User-Agent': 'EarlyEagles/2.0' }, signal: abort(6000) }),
    fetch(`${STACKS_API}/extended/v1/tokens/nft/holdings?principal=${address}&asset_identifiers=${encodeURIComponent(IDENTITY_REGISTRY)}`, { signal: abort(6000) }),
    fetch(`${STACKS_API}/extended/v1/tokens/nft/holdings?principal=${address}&asset_identifiers=${encodeURIComponent(EAGLE_ASSET)}`, { signal: abort(6000) }),
  ]);

  let level = null, has_erc8004 = false;
  if (genesisRes.status === 'fulfilled' && genesisRes.value.ok) { level = (await genesisRes.value.json()).level; }
  if (erc8004Res.status === 'fulfilled' && erc8004Res.value.ok) { has_erc8004 = ((await erc8004Res.value.json()).results || []).length > 0; }
  if (!(level >= 2 && has_erc8004)) {
    return res.status(403).json({ authorized: false, reason: 'Not a Genesis agent (requires AIBTC level >= 2 + on-chain ERC-8004)' });
  }

  let eagle_token_ids = [];
  if (eagleRes.status === 'fulfilled' && eagleRes.value.ok) {
    eagle_token_ids = ((await eagleRes.value.json()).results || [])
      .map(h => parseInt((h.value?.repr || '').replace(/^u/, ''), 10))
      .filter(id => !isNaN(id));
  }

  const tier = eagle_token_ids.length > 0 ? 'eagle' : 'genesis';
  return res.status(200).json({
    authorized: true, tier, address,
    ...(tier === 'eagle' ? { eagle_token_ids } : {}),
    verified_at: new Date().toISOString(),
  });
};
