/**
 * Early Eagles — GET /api/gallery
 *
 * Returns pre-built gallery data: renderer segments + all eagle data.
 * Vercel edge-caches this for 60s so users get instant gallery loads.
 * Server-side fetches from Hiro API — no rate limit issues for clients.
 */

// Mainnet only
const STACKS_API = 'https://api.hiro.so';
// Deploy address for Early Eagles mainnet contracts
const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS || 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2';

const NFT_CONTRACT = process.env.NFT_CONTRACT_NAME || 'early-eagles';
// Renderer deployed from same address on mainnet
const RENDERER_ADDRESS = process.env.ADMIN_ADDRESS || 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2';

const RENDERER_NAME = process.env.RENDERER_NAME || 'early-eagles-renderer';

const CORS = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || 'https://early-eagles.vercel.app',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const TIER_NAMES = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];
const TIER_IDS = ['legendary', 'epic', 'rare', 'uncommon', 'common'];

// ── Hiro API helper with retries ──
async function callRead(contract, fn, args = [], retries = 4, contractAddr = ADMIN_ADDRESS) {
  const url = `${STACKS_API}/v2/contracts/call-read/${contractAddr}/${contract}/${fn}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: ADMIN_ADDRESS, arguments: args }),
      });
      if (res.status === 429) {
        const wait = 2000 + attempt * 3000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`API ${res.status} for ${fn}`);
      return res.json();
    } catch (e) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2000 + attempt * 2000));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Max retries for ${fn}`);
}

function decodeSegment(d) {
  let hex = d.result.replace('0x', '');
  if (hex.startsWith('07')) hex = hex.slice(2);
  if (hex.startsWith('0d') || hex.startsWith('09')) hex = hex.slice(2);
  const len = parseInt(hex.slice(0, 8), 16);
  const strHex = hex.slice(8, 8 + len * 2);
  return (strHex.match(/.{2}/g) || []).map(b => parseInt(b, 16)).reduce((a, c) => a + String.fromCharCode(c), '');
}

function decodeRenderParams(hexResult) {
  const hex = (hexResult || '').replace('0x', '').slice(4);
  const len = parseInt(hex.slice(0, 8), 16);
  const strHex = hex.slice(8, 8 + len * 2);
  return strHex.match(/.{2}/g).map(b => parseInt(b, 16)).reduce((a, c) => a + String.fromCharCode(c), '');
}

function encodeUint(n) {
  return '0x01' + n.toString(16).padStart(32, '0');
}

// C32 abbreviation for owner display
function decodeOwner(hexResult) {
  try {
    const hex = hexResult.replace('0x', '');
    if (!hex.startsWith('070a05')) return null;
    const hashHex = hex.slice(8, 48);
    return 'ST' + hashHex.toUpperCase().slice(0, 6) + '…' + hashHex.toUpperCase().slice(-4);
  } catch (e) { return null; }
}

// ── In-memory cache (persists across warm Vercel invocations) ──
let _segCache = null;
let _eagleCache = { eagles: [], totalMinted: 0, builtAt: 0 };

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  // Edge cache: 60s fresh, 5min stale-while-revalidate
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

  try {
    // 1. Get total minted
    const lastIdRes = await callRead(NFT_CONTRACT, 'get-last-token-id');
    const totalMinted = parseInt(lastIdRes.result.slice(6), 16) || 0;

    // 2. Get renderer segments (cache in memory — they're locked)
    if (!_segCache) {
      const seg1 = decodeSegment(await callRead(RENDERER_NAME, 'get-seg1', [], 4, RENDERER_ADDRESS));
      const eagle = decodeSegment(await callRead(RENDERER_NAME, 'get-eagle', [], 4, RENDERER_ADDRESS));
      const seg2 = decodeSegment(await callRead(RENDERER_NAME, 'get-seg2', [], 4, RENDERER_ADDRESS));
      const seg3 = decodeSegment(await callRead(RENDERER_NAME, 'get-seg3', [], 4, RENDERER_ADDRESS));
      _segCache = { seg1, eagle, seg2, seg3 };
    }

    // 3. Build eagle data — reuse cached eagles, only fetch new ones
    let eagles = [..._eagleCache.eagles];
    const startFrom = _eagleCache.totalMinted;

    for (let id = startFrom; id < totalMinted; id++) {
      try {
        const uintArg = encodeUint(id);

        // Fetch render params
        const paramsRes = await callRead(NFT_CONTRACT, 'get-render-params', [uintArg]);
        let html = null;
        let meta = { name: `Eagle #${id}`, tier: 0, cid: 0, rank: id };

        if (paramsRes.okay && paramsRes.result) {
          const jsonStr = decodeRenderParams(paramsRes.result);
          if (jsonStr) {
            const parsed = JSON.parse(jsonStr);
            meta = { ...meta, ...parsed };
            html = _segCache.seg1 + _segCache.eagle + _segCache.seg2 + jsonStr + _segCache.seg3;
          }
        }

        // Fetch owner
        let owner = null;
        try {
          const ownerRes = await callRead(NFT_CONTRACT, 'get-owner', [uintArg]);
          if (ownerRes.okay && ownerRes.result) {
            owner = decodeOwner(ownerRes.result);
          }
        } catch (e) { /* skip */ }

        const tierIdx = typeof meta.tier === 'number' ? meta.tier : 0;

        eagles.push({
          id,
          name: meta.name || `Eagle #${id}`,
          tier: tierIdx,
          tierName: TIER_NAMES[tierIdx] || 'Common',
          tierId: TIER_IDS[tierIdx] || 'common',
          rank: meta.rank || id,
          cid: meta.cid || 0,
          owner,
          html,
        });
      } catch (e) {
        console.warn(`Failed to fetch eagle ${id}:`, e.message);
      }
    }
    // Update in-memory cache
    _eagleCache = { eagles, totalMinted, builtAt: Date.now() };

    return res.status(200).json({
      totalMinted,
      totalSupply: 420,
      renderer: RENDERER_NAME,
      builtAt: new Date().toISOString(),
      eagles,
    });

  } catch (e) {
    console.error('Gallery API error:', e.message);
    // If we have cached data, return it even on error
    if (_eagleCache.eagles.length > 0) {
      return res.status(200).json({
        totalMinted: _eagleCache.totalMinted,
        totalSupply: 420,
        renderer: RENDERER_NAME,
        builtAt: new Date(_eagleCache.builtAt).toISOString(),
        stale: true,
        eagles: _eagleCache.eagles,
      });
    }
    return res.status(500).json({ error: 'Gallery temporarily unavailable' });
  }
};
