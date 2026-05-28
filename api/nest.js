/**
 * Early Eagles — /api/nest
 *
 * GET  /api/nest?address=SP...  → challenge nonce to sign
 * POST /api/nest                → verify signature, return tier
 *
 * Nonce format: EaglesNest:<address>:<bucket>
 *   bucket = Math.floor(Date.now() / 600_000)  (10-min windows)
 *
 * Signing:
 *   sign_hash = sha256(nonce)
 *   signature = signMessageHashRsv(privateKey, sign_hash)  [130-char RSV hex]
 *
 * POST body: { address: "SP...", signature: "<130-char hex>" }
 * POST response: { authorized, tier: "eagle"|"genesis", address, eagle_token_ids?, verified_at }
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

// Rate limiting: 10 req / 60s per IP for POST, 60 for GET
const RATE_MAP = new Map();
function rateOk(ip, max) {
  const now = Date.now();
  const e = RATE_MAP.get(ip);
  if (!e || now > e.r) { RATE_MAP.set(ip, { c: 1, r: now + 60_000 }); return true; }
  if (e.c >= max) return false;
  e.c++;
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of RATE_MAP) if (now > v.r) RATE_MAP.delete(k); }, 300_000);

function abort(ms) { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; }

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

function normalizeAddress(raw) {
  return raw.startsWith('ST') ? 'SP' + raw.slice(2) : raw;
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  const ip = req.headers['x-forwarded-for'] || 'unknown';

  // ── GET: return challenge nonce ──────────────────────────────────────────
  if (req.method === 'GET') {
    if (!rateOk(ip, 60)) return res.status(429).json({ error: 'Too many requests' });
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

  // ── POST: verify signature + on-chain state ──────────────────────────────
  if (req.method === 'POST') {
    if (!rateOk(ip, 10)) return res.status(429).json({ authorized: false, reason: 'Too many attempts' });

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
    if (genesisRes.status === 'fulfilled' && genesisRes.value.ok) {
      level = (await genesisRes.value.json()).level;
    }
    if (erc8004Res.status === 'fulfilled' && erc8004Res.value.ok) {
      has_erc8004 = ((await erc8004Res.value.json()).results || []).length > 0;
    }
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
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
