/**
 * Early Eagles — /api/shuffle
 * Returns tier distribution info. Assignments are random at mint time.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
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
      epic:      { count: 60, colors: 10, note: '6 of each color' },
      rare:      { count: 80, colors: 10, note: '8 of each color' },
      uncommon:  { count: 150, colors: 12, note: '12-13 of each color' },
      common:    { count: 120, colors: 12, note: '10 of each color' },
    },
  });
};
