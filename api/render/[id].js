/**
 * Eagle render API: GET /api/render/:id
 * Returns the fully assembled HTML for a single eagle, directly renderable in a browser.
 * Segments are locked on-chain — cache aggressively.
 */

const STACKS_API = 'https://api.hiro.so';
const ADMIN_ADDRESS = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2';
const NFT_CONTRACT = 'early-eagles-v2';
const RENDERER_NAME = 'early-eagles-renderer';

// In-memory segment cache — renderer is locked, never changes
let _segs = null;

async function callRead(contract, fn, args = []) {
  const url = `${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDRESS}/${contract}/${fn}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: ADMIN_ADDRESS, arguments: args }),
    });
    if (res.status === 429) { await sleep(2000 + attempt * 3000); continue; }
    if (!res.ok) throw new Error(`Hiro API ${res.status} on ${fn}`);
    return res.json();
  }
  throw new Error(`Max retries on ${fn}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function decodeSeg(d) {
  let hex = d.result.replace('0x', '');
  if (hex.startsWith('07')) hex = hex.slice(2);
  if (hex.startsWith('0d') || hex.startsWith('09')) hex = hex.slice(2);
  const len = parseInt(hex.slice(0, 8), 16);
  return hex.slice(8, 8 + len * 2).match(/.{2}/g).map(b => String.fromCharCode(parseInt(b, 16))).join('');
}

function decodeRenderParams(hexResult) {
  const hex = hexResult.replace('0x', '').slice(4);
  const len = parseInt(hex.slice(0, 8), 16);
  return hex.slice(8, 8 + len * 2).match(/.{2}/g).map(b => String.fromCharCode(parseInt(b, 16))).join('');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const tokenId = parseInt(req.query.id);
  if (isNaN(tokenId) || tokenId < 0 || tokenId > 419) {
    return res.status(400).send('Invalid token ID (0–419)');
  }

  try {
    // Fetch segments once; they're immutable after lock-data
    if (!_segs) {
      const [s1, eagle, s2, s3] = await Promise.all([
        callRead(RENDERER_NAME, 'get-seg1'),
        callRead(RENDERER_NAME, 'get-eagle'),
        callRead(RENDERER_NAME, 'get-seg2'),
        callRead(RENDERER_NAME, 'get-seg3'),
      ]);
      _segs = { s1: decodeSeg(s1), eagle: decodeSeg(eagle), s2: decodeSeg(s2), s3: decodeSeg(s3) };
    }

    // Fetch render-params for this specific token
    const uintArg = '0x01' + tokenId.toString(16).padStart(32, '0');
    const paramsRes = await callRead(NFT_CONTRACT, 'get-render-params', [uintArg]);

    if (!paramsRes.okay || !paramsRes.result || paramsRes.result === '0x09') {
      return res.status(404).send('Token not minted yet');
    }

    const jsonStr = decodeRenderParams(paramsRes.result);
    const html = _segs.s1 + _segs.eagle + _segs.s2 + jsonStr + _segs.s3;

    // Segments + render-params are immutable post-mint — cache for 1h
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);

  } catch (e) {
    console.error(`Render API error for token ${tokenId}:`, e.message);
    return res.status(500).send('Render temporarily unavailable');
  }
};
