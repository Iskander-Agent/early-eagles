/**
 * Early Eagles — collection info handler
 *
 * GET /api/utilities[?status=live|building|planned]
 *   Returns the holder utility registry. Data lives in /data/utilities.json.
 *   Includes docs field and a plain-text agent_summary for machine consumption.
 *
 * GET /api/shuffle
 *   Returns static tier distribution info (random-at-mint).
 */

const path = require('path');
const fs = require('fs');

const CORS = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || 'https://early-eagles.vercel.app',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── /api/shuffle — static tier distribution ──────────────────────────────────

function handleShuffle(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).json({
    total: 420,
    method: 'random-at-mint',
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

// ── /api/utilities — holder utility registry ──────────────────────────────────

async function handleUtilities(req, res) {
  let utilities;
  try {
    const dataPath = path.join(__dirname, '..', 'data', 'utilities.json');
    utilities = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch (err) {
    console.error('Failed to read utilities.json:', err.message);
    return res.status(500).json({ error: 'Could not load utilities data' });
  }

  const { status } = req.query;
  const filtered = status
    ? utilities.filter(u => u.status === status)
    : utilities;

  const live     = utilities.filter(u => u.status === 'live');
  const building = utilities.filter(u => u.status === 'building');
  const planned  = utilities.filter(u => u.status === 'planned');

  const agentSummary = live.length > 0
    ? `Holding an Early Eagle currently unlocks: ${live.map(u => u.name).join(', ')}. ` +
      `Coming soon: ${building.map(u => u.name).join(', ')}.`
    : 'Utility integrations are in progress. Check back soon.';

  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  return res.status(200).json({
    total: utilities.length,
    counts: { live: live.length, building: building.length, planned: planned.length },
    agent_summary: agentSummary,
    utilities: filtered,
  });
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const urlPath = (req.url || '').split('?')[0];

  if (urlPath.endsWith('/shuffle'))   return handleShuffle(req, res);
  if (urlPath.endsWith('/utilities')) return handleUtilities(req, res);

  return res.status(404).json({ error: 'Not found' });
};
