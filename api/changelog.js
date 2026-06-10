const path = require('path');
const fs   = require('fs');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  try {
    const file    = path.join(__dirname, '..', 'data', 'changelog.json');
    const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Sort newest-first
    entries.sort((a, b) => b.date.localeCompare(a.date));
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
    res.end(JSON.stringify(entries));
  } catch (err) {
    res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
};
