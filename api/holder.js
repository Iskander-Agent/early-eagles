/**
 * Early Eagles — GET /api/holder?address=SP...
 *
 * Returns whether a Stacks address holds an Early Eagle.
 * Queries Hiro NFT holdings API for the early-eagles-v2 collection.
 *
 * Response:
 *   { address, holds_eagle, token_ids, count, verified_at }
 */

const STACKS_API = 'https://api.hiro.so';
const EAGLE_ASSET = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2.early-eagles-v2::early-eagles';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Rate limiting: 60 req / 60s per IP
const RATE_MAP = new Map();
function rateOk(ip) {
  const now = Date.now();
  const e = RATE_MAP.get(ip);
  if (!e || now > e.r) { RATE_MAP.set(ip, { c: 1, r: now + 60_000 }); return true; }
  if (e.c >= 60) return false;
  e.c++;
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of RATE_MAP) if (now > v.r) RATE_MAP.delete(k); }, 300_000);

function abort(ms) { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; }

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!rateOk(ip)) return res.status(429).json({ error: 'Too many requests' });

  const rawAddr = (req.query || {}).address;
  if (!rawAddr) return res.status(400).json({ error: 'Missing ?address= parameter' });
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) return res.status(400).json({ error: 'Invalid Stacks address' });

  const address = rawAddr.startsWith('ST') ? 'SP' + rawAddr.slice(2)
                : rawAddr.startsWith('SN') ? 'SM' + rawAddr.slice(2)
                : rawAddr;

  try {
    const url = `${STACKS_API}/extended/v1/tokens/nft/holdings` +
      `?principal=${address}&asset_identifiers=${encodeURIComponent(EAGLE_ASSET)}&limit=50`;
    const hiroRes = await fetch(url, { signal: abort(6000) });
    if (!hiroRes.ok) throw new Error(`Hiro API ${hiroRes.status}`);

    const data = await hiroRes.json();
    const holdings = data.results || [];
    const token_ids = holdings.map(h => {
      const raw = h.value?.repr || '';
      const id = parseInt(raw.replace(/^u/, ''), 10);
      return isNaN(id) ? null : id;
    }).filter(id => id !== null);

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({
      address,
      holds_eagle: token_ids.length > 0,
      token_ids,
      count: token_ids.length,
      verified_at: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(503).json({ error: 'Chain check failed', detail: e.message });
  }
};
