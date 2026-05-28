/**
 * Early Eagles — POST /api/nest/authorize
 *
 * Lets an Eagle holder link one Telegram user to their Eagle.
 * One human account per Eagle, max. If the Eagle changes hands, the new
 * holder calls this endpoint and the old mapping is evicted.
 *
 * Flow:
 *   1. GET /api/nest?address=SP... → get challenge nonce
 *   2. Sign the nonce hash with your wallet private key (same as /api/nest)
 *   3. POST /api/nest/authorize { address, signature, telegram_user_id }
 *   4. Server verifies sig + on-chain Eagle holding + writes KV mapping
 *
 * POST body:
 *   { address: "SP...", signature: "<130-char RSV hex>", telegram_user_id: "<string>" }
 *
 * Nonce / signing — identical to /api/nest:
 *   nonce     = "EaglesNest:<address>:<bucket>"  (bucket = floor(Date.now()/600_000))
 *   sign_hash = sha256(nonce)  [hex]
 *   signature = signMessageHashRsv(privateKey, sign_hash)
 *
 * Returns:
 *   { success, eagle_token_id, telegram_user_id, evicted_telegram_user_id? }
 */

const { publicKeyFromSignatureRsv, getAddressFromPublicKey, createMessageSignature, TransactionVersion } = require('@stacks/transactions');
const { sha256 } = require('@noble/hashes/sha256');
const { kv } = require('@vercel/kv');

const STACKS_API  = 'https://api.hiro.so';
const EAGLE_ASSET = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2.early-eagles-v2::early-eagles';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Rate limiting: 5 POST / 60s per IP (auth is expensive, limit abuse)
const RATE_MAP = new Map();
function rateOk(ip) {
  const now = Date.now();
  const e = RATE_MAP.get(ip);
  if (!e || now > e.r) { RATE_MAP.set(ip, { c: 1, r: now + 60_000 }); return true; }
  if (e.c >= 5) return false;
  e.c++;
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of RATE_MAP) if (now > v.r) RATE_MAP.delete(k); }, 300_000);

function abort(ms) { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; }

function normalizeAddress(raw) {
  return raw.startsWith('ST') ? 'SP' + raw.slice(2) : raw;
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
  if (!r.ok) throw new Error(`Hiro API ${r.status}`);
  const data = await r.json();
  return (data.results || [])
    .map(h => parseInt((h.value?.repr || '').replace(/^u/, ''), 10))
    .filter(id => !isNaN(id));
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!rateOk(ip)) return res.status(429).json({ error: 'Too many requests. Try again in 1 minute.' });

  const { address: rawAddr, signature, telegram_user_id } = req.body || {};

  if (!rawAddr || !signature || !telegram_user_id) {
    return res.status(400).json({ error: 'Missing required fields: address, signature, telegram_user_id' });
  }
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) {
    return res.status(400).json({ error: 'Invalid Stacks address format' });
  }
  if (!/^[0-9a-fA-F]{130}$/.test(signature)) {
    return res.status(400).json({ error: 'Invalid signature (expect 130-char RSV hex)' });
  }
  if (!/^\d+$/.test(String(telegram_user_id))) {
    return res.status(400).json({ error: 'telegram_user_id must be a numeric string' });
  }

  const address = normalizeAddress(rawAddr);
  const tg = String(telegram_user_id);

  // 1. Verify signature
  if (!verifyNonceSignature(address, signature)) {
    return res.status(401).json({
      error: 'Signature invalid or nonce expired.',
      hint: 'GET /api/nest?address=<SP...> for a fresh nonce, sign it, then retry.',
    });
  }

  // 2. Verify on-chain Eagle holding
  let token_ids;
  try {
    token_ids = await getEagleTokenIds(address);
  } catch (e) {
    return res.status(503).json({ error: 'On-chain check failed. Try again shortly.' });
  }

  if (token_ids.length === 0) {
    return res.status(403).json({ error: 'Address holds no Early Eagles. Must hold ≥1 Eagle to authorize a Telegram account.' });
  }

  // Use the lowest token_id as the canonical Eagle for this address.
  // Sort first — Hiro API doesn't guarantee order.
  token_ids.sort((a, b) => a - b);
  const eagle_token_id = token_ids[0];

  // 3. Check if this Eagle already has a linked Telegram user → evict old mapping
  const eagleKey = `nest:eagle:${eagle_token_id}`;
  const tgKey    = `nest:tg:${tg}`;

  let evicted = null;
  try {
    const existing_tg = await kv.get(eagleKey);
    if (existing_tg && existing_tg !== tg) {
      // Evict old reverse-lookup
      evicted = existing_tg;
      await kv.del(`nest:tg:${existing_tg}`);
    }

    // Check if this Telegram user was mapped to a *different* Eagle → clean that up too
    const existing_eagle = await kv.get(tgKey);
    if (existing_eagle !== null && existing_eagle !== eagle_token_id) {
      await kv.del(`nest:eagle:${existing_eagle}`);
    }

    // Write new mapping (both directions)
    await kv.set(eagleKey, tg);
    await kv.set(tgKey, eagle_token_id);
  } catch (e) {
    return res.status(503).json({ error: 'Storage unavailable. Try again shortly.' });
  }

  const response = {
    success: true,
    eagle_token_id,
    telegram_user_id: tg,
    address,
    authorized_at: new Date().toISOString(),
  };
  if (evicted) response.evicted_telegram_user_id = evicted;

  return res.status(200).json(response);
};
