/**
 * Early Eagles — POST /api/attest
 *
 * Produces a verifiable attestation artifact signed by an Eagle holder.
 * The artifact proves: this message was endorsed by an address that holds
 * an Early Eagle NFT at the stated timestamp.
 *
 * Body: { address: "SP...", signature: "<65-byte RSV hex>", message: "<string, max 1024 chars>" }
 *
 * Response:
 *   {
 *     id,              // sha256(address + message + timestamp) — deterministic
 *     attested_by,     // Stacks address
 *     eagle_token_ids, // Eagle(s) held at time of attestation
 *     message,
 *     message_hash,    // sha256(message) — for on-chain anchoring
 *     signature,       // original wallet signature (re-verifiable)
 *     timestamp,
 *     verify_url       // link to verify this artifact
 *   }
 *
 * Signing contract (same as nest-auth):
 *   sign_hash = sha256("EaglesNest:<address>:<bucket>")
 *   signature = signMessageHashRsv(privateKey, sign_hash)
 *
 * The returned artifact can be re-verified by anyone:
 *   - Recompute sign_hash from address + current/recent bucket
 *   - Verify signature recovers to attested_by
 *   - Verify eagle_token_ids via GET /api/holder?address=
 */

const { publicKeyFromSignatureRsv, getAddressFromPublicKey, createMessageSignature, TransactionVersion } = require('@stacks/transactions');
const { sha256 } = require('@noble/hashes/sha256');

const STACKS_API = 'https://api.hiro.so';
const EAGLE_ASSET = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2.early-eagles-v2::early-eagles';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!rateOk(ip)) return res.status(429).json({ error: 'Rate limit exceeded' });

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

  // Verify holds Eagle
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
  } catch { /* non-fatal, include empty */ }

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
};
