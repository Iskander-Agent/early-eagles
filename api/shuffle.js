/**
 * Early Eagles — /api/shuffle
 * Returns the pre-committed shuffle proof (commitHash, seed, total).
 * Full assignment array is intentionally omitted to keep response lean;
 * clients can request the full metadata separately.
 */

let SHUFFLE;
try {
  SHUFFLE = require('./shuffle.json');
} catch (e) {
  SHUFFLE = null;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  res.setHeader('Cache-Control', 'public, max-age=3600');

  if (!SHUFFLE) {
    return res.status(500).json({ error: 'Shuffle data not available' });
  }

  return res.json({
    commitHash:  SHUFFLE.commitHash,
    seed:        SHUFFLE.seed,
    total:       Array.isArray(SHUFFLE.assignments) ? SHUFFLE.assignments.length : 0,
  });
};
