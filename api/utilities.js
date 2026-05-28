/**
 * Early Eagles — GET /api/utilities  (v2: includes docs field)
 *
 * Returns the holder utility registry: what owning an Early Eagle unlocks.
 * Data lives in /data/utilities.json — add a utility there, redeploy, done.
 *
 * Optional query param: ?status=live|building|planned
 * Response includes a plain-text agent_summary for machine consumption.
 */

const path = require('path');
const fs = require('fs');

const CORS = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || 'https://early-eagles.vercel.app',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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

  const live = utilities.filter(u => u.status === 'live');
  const building = utilities.filter(u => u.status === 'building');
  const planned = utilities.filter(u => u.status === 'planned');

  const agentSummary = live.length > 0
    ? `Holding an Early Eagle currently unlocks: ${live.map(u => u.name).join(', ')}. ` +
      `Coming soon: ${building.map(u => u.name).join(', ')}.`
    : 'Utility integrations are in progress. Check back soon.';

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    _build: 'v3-docs',
    total: utilities.length,
    counts: { live: live.length, building: building.length, planned: planned.length },
    agent_summary: agentSummary,
    utilities: filtered,
  });
};
