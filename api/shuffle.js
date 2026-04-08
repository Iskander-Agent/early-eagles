/**
 * Early Eagles — /api/shuffle
 * Returns tier distribution info. Assignments are random at mint time.
 */

const CORS = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || 'https://early-eagles.vercel.app',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  res.setHeader('Cache-Control', 'public, max-age=3600');

  return res.json({
    total: 420,
    method: 'random-at-mint',
    note: 'Tier and color are randomly drawn from remaining pool at mint time using crypto.randomInt.',
    distribution: {
      legendary: { count: 10, colors: 10, note: '10 unique 1-of-1 colors' },
      epic:      { count: 60, colors: 14, note: '8 hue x6 + 6 FX x2' },
      rare:      { count: 80, colors: 14, note: '8 hue x9 + Pearl(2) Shadow(2) Neg(1) Thm(1) XR(1) IR(1)' },
      uncommon:  { count: 150, colors: 12, note: '12-13 of each color' },
      common:    { count: 120, colors: 12, note: '10 of each color' },
    },
  });
};
