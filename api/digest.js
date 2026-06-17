/**
 * Early Eagles — /api/digest
 *
 * Last-24h activity summary: new mints + task board movement.
 * Designed as a lightweight polling target for agents and holders.
 *
 * GET /api/digest
 * Response: {
 *   minted_today:   number,   // tokens minted in approx last 24h (by block height)
 *   tasks_posted:   number,   // tasks created in last 24h
 *   tasks_claimed:  number,   // tasks claimed in last 24h
 *   total_minted:   number,   // total supply minted so far
 *   last_updated:   string,   // ISO timestamp
 * }
 */

const STACKS_API   = 'https://api.hiro.so';
const ADMIN_ADDR   = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2';
const NFT_CONTRACT = 'early-eagles-v2';
const TASKS_KEY    = 'eagle-tasks:v1';
// Stacks produces ~1 block per 10 min → ~144 blocks/day
const BLOCKS_PER_DAY = 144;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function abort(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try { return require('@vercel/kv').kv; } catch { return null; }
}

async function readTasks(kv) {
  if (!kv) return {};
  try { return (await kv.get(TASKS_KEY)) || {}; } catch { return {}; }
}

// Returns current Stacks block height
async function fetchBlockHeight() {
  const r = await fetch(`${STACKS_API}/v2/info`, { signal: abort(5000) });
  if (!r.ok) throw new Error(`Hiro /v2/info ${r.status}`);
  const d = await r.json();
  return d.stacks_tip_height ?? d.burn_block_height ?? null;
}

// Returns { lastId, totalMinted }
async function fetchSupply() {
  const { hexToCV, cvToJSON } = await import('@stacks/transactions');
  const r = await fetch(
    `${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDR}/${NFT_CONTRACT}/get-last-token-id`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sender: ADMIN_ADDR, arguments: [] }),
      signal:  abort(6000),
    }
  );
  if (!r.ok) throw new Error(`contract read ${r.status}`);
  const d = await r.json();
  if (!d.okay) throw new Error('contract read failed');
  const cv = cvToJSON(hexToCV(d.result));
  const lastId = parseInt(cv?.value?.value ?? '-1', 10);
  if (isNaN(lastId) || lastId < 0) return { lastId: -1, totalMinted: 0 };
  return { lastId, totalMinted: lastId + 1 };
}

// Returns minted-at block height for a single token, or null on failure
async function fetchMintedAt(tokenId) {
  const { hexToCV, cvToJSON } = await import('@stacks/transactions');
  const arg = '0x01' + tokenId.toString(16).padStart(32, '0');
  const r = await fetch(
    `${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDR}/${NFT_CONTRACT}/get-traits`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sender: ADMIN_ADDR, arguments: [arg] }),
      signal:  abort(6000),
    }
  );
  if (!r.ok) return null;
  const d = await r.json();
  if (!d.okay || d.result === '0x09') return null;
  const cv = cvToJSON(hexToCV(d.result));
  const raw = cv?.value?.value?.['minted-at']?.value;
  if (!raw) return null;
  return parseInt(raw, 10);
}

// Counts tokens minted at or after blockThreshold by scanning backwards from lastId
async function countMintsInWindow(lastId, blockThreshold) {
  if (lastId < 0) return 0;
  let count = 0;
  // Scan in batches of 5 to stay within Vercel function timeout
  for (let i = lastId; i >= 0; i -= 5) {
    const batch = [];
    for (let j = i; j >= 0 && j > i - 5; j--) batch.push(j);
    const results = await Promise.all(batch.map(fetchMintedAt));
    let hitOld = false;
    for (const mintedAt of results) {
      if (mintedAt === null) continue;
      if (mintedAt >= blockThreshold) {
        count++;
      } else {
        hitOld = true;
      }
    }
    // Once all tokens in this batch are older than the window, stop scanning
    if (hitOld && results.every(v => v === null || v < blockThreshold)) break;
  }
  return count;
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');

  try {
    const [supplyResult, heightResult, kv] = await Promise.allSettled([
      fetchSupply(),
      fetchBlockHeight(),
      Promise.resolve(getKv()),
    ]);

    const { lastId, totalMinted } = supplyResult.status === 'fulfilled'
      ? supplyResult.value
      : { lastId: -1, totalMinted: 0 };

    const currentHeight = heightResult.status === 'fulfilled' ? heightResult.value : null;
    const blockThreshold = currentHeight !== null ? currentHeight - BLOCKS_PER_DAY : null;

    // Count recent mints (skip if block height unavailable)
    let mintedToday = 0;
    if (blockThreshold !== null && lastId >= 0) {
      mintedToday = await countMintsInWindow(lastId, blockThreshold);
    }

    // Count task activity in last 24h from KV
    const kvInstance = kv.status === 'fulfilled' ? kv.value : null;
    const tasks       = Object.values(await readTasks(kvInstance));
    const cutoff      = Date.now() - 86_400_000;

    const tasksPosted  = tasks.filter(t => t.created_at && new Date(t.created_at).getTime() >= cutoff).length;
    const tasksClaimed = tasks.filter(t => t.claimed_at  && new Date(t.claimed_at).getTime()  >= cutoff).length;

    return res.status(200).json({
      minted_today:  mintedToday,
      tasks_posted:  tasksPosted,
      tasks_claimed: tasksClaimed,
      total_minted:  totalMinted,
      last_updated:  new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: 'digest failed', detail: e.message });
  }
};
