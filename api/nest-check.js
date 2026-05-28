/**
 * Early Eagles — GET /api/nest/check?telegram_user_id=123456789
 *
 * Used by the Telegram bot to verify if a user has an authorized Eagle.
 * Called when a user tries to join the Eagles Nest group.
 *
 * Query params:
 *   telegram_user_id  — numeric Telegram user ID
 *
 * Returns:
 *   { authorized: true,  eagle_token_id, tier: "eagle" }
 *   { authorized: false, reason }
 */

const { kv } = require('@vercel/kv');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Rate limiting: 30 req / 60s per IP
const RATE_MAP = new Map();
function rateOk(ip) {
  const now = Date.now();
  const e = RATE_MAP.get(ip);
  if (!e || now > e.r) { RATE_MAP.set(ip, { c: 1, r: now + 60_000 }); return true; }
  if (e.c >= 30) return false;
  e.c++;
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of RATE_MAP) if (now > v.r) RATE_MAP.delete(k); }, 300_000);

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!rateOk(ip)) return res.status(429).json({ authorized: false, reason: 'Too many requests' });

  const tg = String((req.query || {}).telegram_user_id || '');
  if (!tg || !/^\d+$/.test(tg)) {
    return res.status(400).json({ authorized: false, reason: 'Missing or invalid telegram_user_id (must be numeric)' });
  }

  let eagle_token_id;
  try {
    eagle_token_id = await kv.get(`nest:tg:${tg}`);
  } catch (e) {
    return res.status(503).json({ authorized: false, reason: 'Storage unavailable. Try again shortly.' });
  }

  if (eagle_token_id === null || eagle_token_id === undefined) {
    return res.status(200).json({
      authorized: false,
      reason: 'Telegram user not linked to any Eagle. The Eagle holder must call POST /api/nest/authorize first.',
    });
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    authorized: true,
    eagle_token_id,
    tier: 'eagle',
  });
};
