/**
 * Early Eagles — GET /api/gallery  +  GET /api/digest  (merged to stay under Vercel 12-fn limit)
 *
 * /api/gallery  — Returns pre-built gallery data: renderer segments + all eagle data.
 * /api/digest   — Last-24h activity summary: new mints + task board movement.
 *
 * Caching layers (gallery):
 *  1. Vercel edge cache — 60s fresh, 5min stale-while-revalidate
 *  2. KV persistent cache — survives cold starts; TTL 10min
 *  3. In-memory cache — fastest path for warm instances
 */

const { fetchCallReadOnlyFunction, cvToValue } = require('@stacks/transactions');
const { STACKS_MAINNET } = require('@stacks/network');
const { c32address } = require('c32check');

// Lazy KV loader — only connect when env vars are present (same pattern as nest.js)
function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try { return require('@vercel/kv').kv; } catch { return null; }
}
const KV_KEY     = 'gallery:data';
const KV_TTL_SEC = 86400; // 24h — data only changes on new mints, not on time

// Mainnet only
const STACKS_API = 'https://api.hiro.so';

// Hardcoded - the contract identity is not a runtime config.
const ADMIN_ADDRESS = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2';
const NFT_CONTRACT = 'early-eagles-v2';
const RENDERER_ADDRESS = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2';
const RENDERER_NAME = 'early-eagles-renderer';

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

// Decode (response (optional principal) ...) hex into c32-encoded address (abbreviated)
function decodeOwner(hexResult) {
  try {
    const hex = hexResult.replace('0x', '');
    let i = 0;
    if (hex.slice(i, i + 2) === '07') i += 2; // response.ok wrapper
    if (hex.slice(i, i + 2) === '0a') i += 2; // optional some
    if (hex.slice(i, i + 2) !== '05') return null; // expect standard principal
    i += 2;
    const versionByte = parseInt(hex.slice(i, i + 2), 16);
    const hashHex = hex.slice(i + 2, i + 42);
    const addr = c32address(versionByte, hashHex);
    return addr.slice(0, 6) + '…' + addr.slice(-4);
  } catch (e) { return null; }
}

// ── In-memory cache (persists across warm Vercel invocations) ──
let _segCache = null;
let _eagleCache = { eagles: [], totalMinted: 0, builtAt: 0 };

// ── /api/digest handler (merged from digest.js) ───────────────────────────────

const TASKS_KEY      = 'eagle-tasks:v1';
const BLOCKS_PER_DAY = 144; // ~1 block/10min × 144 ≈ 24h

function abortDigest(ms) {
  const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal;
}

async function fetchBlockHeight() {
  const r = await fetch(`${STACKS_API}/v2/info`, { signal: abortDigest(5000) });
  if (!r.ok) throw new Error(`Hiro /v2/info ${r.status}`);
  const d = await r.json();
  return d.stacks_tip_height ?? d.burn_block_height ?? null;
}

async function fetchLastTokenId() {
  const { hexToCV, cvToJSON } = await import('@stacks/transactions');
  const r = await fetch(
    `${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDRESS}/${NFT_CONTRACT}/get-last-token-id`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: ADMIN_ADDRESS, arguments: [] }), signal: abortDigest(6000) }
  );
  if (!r.ok) throw new Error(`contract read ${r.status}`);
  const d = await r.json();
  if (!d.okay) throw new Error('contract read failed');
  const cv = cvToJSON(hexToCV(d.result));
  const lastId = parseInt(cv?.value?.value ?? '-1', 10);
  return { lastId: isNaN(lastId) || lastId < 0 ? -1 : lastId,
           totalMinted: isNaN(lastId) || lastId < 0 ? 0 : lastId + 1 };
}

async function fetchMintedAtBlock(tokenId) {
  const { hexToCV, cvToJSON } = await import('@stacks/transactions');
  const arg = '0x01' + tokenId.toString(16).padStart(32, '0');
  const r = await fetch(
    `${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDRESS}/${NFT_CONTRACT}/get-traits`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: ADMIN_ADDRESS, arguments: [arg] }), signal: abortDigest(6000) }
  );
  if (!r.ok) return null;
  const d = await r.json();
  if (!d.okay || d.result === '0x09') return null;
  const cv = cvToJSON(hexToCV(d.result));
  const raw = cv?.value?.value?.['minted-at']?.value;
  return raw ? parseInt(raw, 10) : null;
}

async function countRecentMints(lastId, blockThreshold) {
  if (lastId < 0) return 0;
  let count = 0;
  for (let i = lastId; i >= 0; i -= 5) {
    const batch = [];
    for (let j = i; j >= 0 && j > i - 5; j--) batch.push(j);
    const results = await Promise.all(batch.map(fetchMintedAtBlock));
    let hitOld = false;
    for (const mintedAt of results) {
      if (mintedAt === null) continue;
      mintedAt >= blockThreshold ? count++ : (hitOld = true);
    }
    if (hitOld && results.every(v => v === null || v < blockThreshold)) break;
  }
  return count;
}

async function handleDigest(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');
  try {
    const [supplyResult, heightResult] = await Promise.allSettled([
      fetchLastTokenId(), fetchBlockHeight(),
    ]);
    const { lastId, totalMinted } = supplyResult.status === 'fulfilled'
      ? supplyResult.value : { lastId: -1, totalMinted: 0 };
    const currentHeight = heightResult.status === 'fulfilled' ? heightResult.value : null;
    const blockThreshold = currentHeight !== null ? currentHeight - BLOCKS_PER_DAY : null;
    const mintedToday = blockThreshold !== null && lastId >= 0
      ? await countRecentMints(lastId, blockThreshold) : 0;

    const kv = getKv();
    const tasks = kv ? Object.values((await kv.get(TASKS_KEY).catch(() => null)) || {}) : [];
    const cutoff = Date.now() - 86_400_000;
    return res.status(200).json({
      minted_today:  mintedToday,
      tasks_posted:  tasks.filter(t => t.created_at && new Date(t.created_at).getTime() >= cutoff).length,
      tasks_claimed: tasks.filter(t => t.claimed_at  && new Date(t.claimed_at).getTime()  >= cutoff).length,
      total_minted:  totalMinted,
      last_updated:  new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: 'digest failed', detail: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const urlPath = (req.url || '').split('?')[0];
  if (urlPath.endsWith('/digest')) return handleDigest(req, res);

  // Edge cache: 60s fresh, 5min stale-while-revalidate
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

  try {
    // 1. Get total minted (use get-mint-stats — accurate count, not last-id)
    const statsCV = await fetchCallReadOnlyFunction({
      contractAddress: ADMIN_ADDRESS,
      contractName: NFT_CONTRACT,
      functionName: 'get-mint-stats',
      functionArgs: [],
      senderAddress: ADMIN_ADDRESS,
      network: STACKS_MAINNET,
    });
    const stats = cvToValue(statsCV);
    const totalMinted = parseInt(stats['total-minted'].value, 10) || 0;

    // 2. Get renderer segments (cache in memory — they're locked)
    if (!_segCache) {
      const seg1 = decodeSegment(await callRead(RENDERER_NAME, 'get-seg1', [], 4, RENDERER_ADDRESS));
      const eagle = decodeSegment(await callRead(RENDERER_NAME, 'get-eagle', [], 4, RENDERER_ADDRESS));
      const seg2 = decodeSegment(await callRead(RENDERER_NAME, 'get-seg2', [], 4, RENDERER_ADDRESS));
      const seg3 = decodeSegment(await callRead(RENDERER_NAME, 'get-seg3', [], 4, RENDERER_ADDRESS));
      _segCache = { seg1, eagle, seg2, seg3 };
    }

    // 3. Build eagle data — KV → in-memory → fetch delta
    // Try KV first (survives cold starts)
    if (_eagleCache.eagles.length === 0) {
      const kv = getKv();
      if (kv) {
        try {
          const kvData = await kv.get(KV_KEY);
          if (kvData && kvData.eagles) {
            _eagleCache = { eagles: kvData.eagles, totalMinted: kvData.totalMinted, builtAt: kvData.builtAt };
            console.log(`[gallery] KV cache hit: ${kvData.eagles.length} eagles`);
          }
        } catch (e) { console.warn('[gallery] KV read failed:', e.message); }
      }
    }

    let eagles = [..._eagleCache.eagles];
    const startFrom = _eagleCache.totalMinted;

    if (startFrom < totalMinted) {
      // Fetch new eagles in parallel batches of 8
      const newIds = Array.from({ length: totalMinted - startFrom }, (_, i) => startFrom + i);
      const BATCH = 8;
      for (let b = 0; b < newIds.length; b += BATCH) {
        const batch = newIds.slice(b, b + BATCH);
        const results = await Promise.allSettled(batch.map(async id => {
          const uintArg = encodeUint(id);
          const [paramsRes, ownerRes] = await Promise.allSettled([
            callRead(NFT_CONTRACT, 'get-render-params', [uintArg]),
            callRead(NFT_CONTRACT, 'get-owner', [uintArg]),
          ]);
          let html = null;
          let meta = { name: `Eagle #${id}`, tier: 0, cid: 0, rank: id };
          if (paramsRes.status === 'fulfilled' && paramsRes.value?.okay && paramsRes.value?.result) {
            const jsonStr = decodeRenderParams(paramsRes.value.result);
            if (jsonStr) {
              const parsed = JSON.parse(jsonStr);
              meta = { ...meta, ...parsed };
              html = _segCache.seg1 + _segCache.eagle + _segCache.seg2 + jsonStr + _segCache.seg3;
            }
          }
          let owner = null;
          if (ownerRes.status === 'fulfilled' && ownerRes.value?.okay && ownerRes.value?.result) {
            owner = decodeOwner(ownerRes.value.result);
          }
          const tierIdx = typeof meta.tier === 'number' ? meta.tier : 0;
          return { id, name: meta.name || `Eagle #${id}`, tier: tierIdx, tierName: TIER_NAMES[tierIdx] || 'Common', tierId: TIER_IDS[tierIdx] || 'common', rank: meta.rank || id, cid: meta.cid || 0, owner, html };
        }));
        for (const r of results) {
          if (r.status === 'fulfilled') eagles.push(r.value);
          else console.warn('[gallery] eagle fetch failed:', r.reason?.message);
        }
      }
    }

    // Update in-memory cache
    _eagleCache = { eagles, totalMinted, builtAt: Date.now() };

    // Write to KV whenever we fetched new data from Hiro (new mints or first cold-start load).
    // startFrom=0 + totalMinted=30 on first cold start → condition is true → primes KV.
    // TTL 24h: data only changes when totalMinted increases, not on time.
    const kv = getKv();
    if (kv && startFrom < totalMinted) {
      kv.set(KV_KEY, { eagles, totalMinted, builtAt: _eagleCache.builtAt }, { ex: KV_TTL_SEC })
        .catch(e => console.warn('[gallery] KV write failed:', e.message));
    }

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
