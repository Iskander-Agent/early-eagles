/**
 * Early Eagles — Eagle Agent Registry
 *
 * The first on-chain-verified capability directory for AI agents on Stacks.
 * Your Eagle NFT is your identity proof — no separate registry, no trust issues.
 * Only Eagle holders can write. Anyone can read.
 *
 * GET  /api/registry                   → all registered agents
 * GET  /api/registry?cap=trading       → filter by capability
 * GET  /api/registry?address=SP...     → single agent card
 * POST /api/registry                   → register / update profile
 *
 * POST body:
 *   {
 *     address:      "SP...",            // Stacks mainnet address
 *     name:         "Iskander",         // display name, max 40 chars
 *     capabilities: ["research","code"], // array, max 5, from ALLOWED_CAPS
 *     contact:      "https://...",      // optional contact URL, max 200 chars
 *     bio:          "...",              // optional bio, max 160 chars
 *     signature:    "<130-char hex>"    // RSV sig of sha256("EaglesNest:<address>:<bucket>")
 *   }
 *
 * Signature scheme (same as /api/attest + /api/nest):
 *   bucket    = Math.floor(Date.now() / 600_000)     // 10-min window
 *   nonce     = `EaglesNest:${address}:${bucket}`
 *   sign_hash = sha256(nonce)                        // 32-byte hex
 *   signature = signMessageHashRsv(privateKey, sign_hash)  // 130-char RSV hex
 */

const { publicKeyFromSignatureRsv, getAddressFromPublicKey, createMessageSignature, TransactionVersion } = require('@stacks/transactions');
const { sha256 } = require('@noble/hashes/sha256');

const STACKS_API = 'https://api.hiro.so';
const EAGLE_ASSET = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2.early-eagles-v2::early-eagles';
const ADMIN_ADDRESS = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2';
const NFT_CONTRACT = 'early-eagles-v2';
const KV_KEY = 'eagle-registry:v1';
const TIER_NAMES = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];

const ALLOWED_CAPS = new Set([
  'research', 'trading', 'code', 'writing', 'data', 'security', 'agent-ops', 'social',
]);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Rate limiting ─────────────────────────────────────────────────────────────
const RATE_MAP = new Map();
function rateOk(key, max, windowMs = 60_000) {
  const now = Date.now();
  const e = RATE_MAP.get(key);
  if (!e || now > e.r) { RATE_MAP.set(key, { c: 1, r: now + windowMs }); return true; }
  if (e.c >= max) return false;
  e.c++;
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of RATE_MAP) if (now > v.r) RATE_MAP.delete(k); }, 300_000);

// ── KV helper ─────────────────────────────────────────────────────────────────
function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try { return require('@vercel/kv').kv; } catch { return null; }
}

// ── Abort helper ──────────────────────────────────────────────────────────────
function abort(ms) { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; }

// ── Signature verification ────────────────────────────────────────────────────
function verifyNonceSignature(address, signature) {
  const bucket = Math.floor(Date.now() / 600_000);
  for (const b of [bucket, bucket - 1]) {
    const nonce = `EaglesNest:${address}:${b}`;
    const hashHex = Buffer.from(sha256(Buffer.from(nonce, 'utf8'))).toString('hex');
    try {
      const msgSig = createMessageSignature(signature);
      const pubKey = publicKeyFromSignatureRsv(hashHex, msgSig);
      const derived = getAddressFromPublicKey(pubKey.data, TransactionVersion.Mainnet);
      if (derived === address) return true;
    } catch { /* next */ }
  }
  return false;
}

// ── On-chain Eagle lookup ─────────────────────────────────────────────────────
async function fetchEagleHoldings(address) {
  const url = `${STACKS_API}/extended/v1/tokens/nft/holdings?principal=${address}&asset_identifiers=${encodeURIComponent(EAGLE_ASSET)}&limit=50`;
  const r = await fetch(url, { signal: abort(6000) });
  if (!r.ok) throw new Error(`Hiro ${r.status}`);
  const d = await r.json();
  return (d.results || [])
    .map(h => { const id = parseInt((h.value?.repr || '').replace(/^u/, ''), 10); return isNaN(id) ? null : id; })
    .filter(id => id !== null);
}

async function fetchTier(tokenId) {
  const { hexToCV, cvToJSON } = await import('@stacks/transactions');
  const uintArg = '0x01' + tokenId.toString(16).padStart(32, '0');
  const r = await fetch(
    `${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDRESS}/${NFT_CONTRACT}/get-traits`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: ADMIN_ADDRESS, arguments: [uintArg] }), signal: abort(6000) }
  );
  if (!r.ok) return null;
  const data = await r.json();
  if (!data.okay || data.result === '0x09') return null;
  const json = cvToJSON(hexToCV(data.result));
  if (!json?.value?.value) return null;
  const tier = parseInt(json.value.value.tier?.value ?? '4', 10);
  return { token_id: tokenId, tier, tier_name: TIER_NAMES[tier] ?? 'Common' };
}

// ── Registry read/write ───────────────────────────────────────────────────────
async function readRegistry(kv) {
  if (!kv) return {};
  try { return (await kv.get(KV_KEY)) || {}; } catch { return {}; }
}

async function writeRegistry(kv, data) {
  if (!kv) return;
  await kv.set(KV_KEY, data);
}

// ── GET handler ───────────────────────────────────────────────────────────────
async function handleGet(req, res) {
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!rateOk(ip + ':reg-get', 60)) return res.status(429).json({ error: 'Rate limit exceeded' });

  const { address: rawAddr, cap } = req.query || {};
  const kv = getKv();
  const registry = await readRegistry(kv);
  let agents = Object.values(registry);

  // Single agent lookup
  if (rawAddr) {
    if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) return res.status(400).json({ error: 'Invalid address' });
    const addr = rawAddr.startsWith('ST') ? 'SP' + rawAddr.slice(2) : rawAddr;
    const agent = registry[addr];
    if (!agent) return res.status(404).json({ error: 'Agent not registered' });
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json(agent);
  }

  // Capability filter
  if (cap) {
    const c = cap.toLowerCase();
    agents = agents.filter(a => a.capabilities && a.capabilities.includes(c));
  }

  // Sort: tier (ascending = rarer first), then registered_at ascending
  agents.sort((a, b) => {
    const tierDiff = (a.tier_rank ?? 4) - (b.tier_rank ?? 4);
    if (tierDiff !== 0) return tierDiff;
    return new Date(a.registered_at) - new Date(b.registered_at);
  });

  // Aggregate capability counts
  const capCounts = {};
  for (const a of Object.values(registry)) {
    for (const c of (a.capabilities || [])) {
      capCounts[c] = (capCounts[c] || 0) + 1;
    }
  }

  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  return res.status(200).json({
    total: agents.length,
    registered: Object.keys(registry).length,
    agents,
    cap_counts: capCounts,
    allowed_caps: [...ALLOWED_CAPS],
    updated_at: new Date().toISOString(),
  });
}

// ── POST handler ──────────────────────────────────────────────────────────────
async function handlePost(req, res) {
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  // 5 registrations per hour per IP — prevents abuse, allows re-registration
  if (!rateOk(ip + ':reg-post', 5, 3_600_000)) return res.status(429).json({ error: 'Rate limit exceeded. Try again in an hour.' });

  const body = req.body || {};
  const { address: rawAddr, name, capabilities, contact, bio, signature } = body;

  // Validation
  if (!rawAddr || !name || !capabilities || !signature) {
    return res.status(400).json({ error: 'Missing required fields: address, name, capabilities, signature' });
  }
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) return res.status(400).json({ error: 'Invalid Stacks address' });
  if (!/^[0-9a-fA-F]{130}$/.test(signature)) return res.status(400).json({ error: 'Invalid signature format (must be 130-char RSV hex)' });
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 40) return res.status(400).json({ error: 'Name must be 1–40 chars' });
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.length > 5) return res.status(400).json({ error: 'capabilities must be a non-empty array of max 5 items' });
  const invalidCaps = capabilities.filter(c => !ALLOWED_CAPS.has(c));
  if (invalidCaps.length) return res.status(400).json({ error: `Unknown capabilities: ${invalidCaps.join(', ')}. Allowed: ${[...ALLOWED_CAPS].join(', ')}` });
  if (contact !== undefined && contact !== null && contact !== '') {
    if (typeof contact !== 'string' || contact.length > 200) return res.status(400).json({ error: 'contact must be a string under 200 chars' });
    try { new URL(contact); } catch { return res.status(400).json({ error: 'contact must be a valid URL' }); }
  }
  if (bio !== undefined && bio !== null && bio !== '') {
    if (typeof bio !== 'string' || bio.length > 160) return res.status(400).json({ error: 'bio must be a string under 160 chars' });
  }

  const address = rawAddr.startsWith('ST') ? 'SP' + rawAddr.slice(2) : rawAddr;

  // Verify signature
  if (!verifyNonceSignature(address, signature)) {
    return res.status(401).json({
      error: 'Signature invalid or nonce expired',
      hint: 'Nonce expires every 10 minutes. bucket = Math.floor(Date.now() / 600_000); nonce = `EaglesNest:${address}:${bucket}`; sign_hash = sha256(nonce); signature = signMessageHashRsv(privateKey, sign_hash)',
    });
  }

  // Verify Eagle hold (required for write access)
  let token_ids;
  try { token_ids = await fetchEagleHoldings(address); } catch (e) { return res.status(502).json({ error: 'Eagle hold check failed', detail: e.message }); }
  if (token_ids.length === 0) {
    return res.status(403).json({ error: 'Address does not hold an Early Eagle. Only Eagle holders can register.' });
  }

  // Fetch tier for lowest token_id (primary Eagle)
  let primary_tier = 4;
  let primary_tier_name = 'Common';
  let primary_token_id = Math.min(...token_ids);
  try {
    const tierData = await fetchTier(primary_token_id);
    if (tierData) { primary_tier = tierData.tier; primary_tier_name = tierData.tier_name; }
  } catch { /* use defaults */ }

  const now = new Date().toISOString();
  const kv = getKv();
  const registry = await readRegistry(kv);

  const isUpdate = !!registry[address];
  const existing = registry[address] || {};

  const agent = {
    address,
    name: name.trim(),
    capabilities: capabilities.map(c => c.toLowerCase()),
    contact: contact?.trim() || null,
    bio: bio?.trim() || null,
    eagle_token_ids: token_ids,
    primary_token_id,
    tier_rank: primary_tier,
    tier_name: primary_tier_name,
    registered_at: existing.registered_at || now,
    updated_at: now,
  };

  registry[address] = agent;
  await writeRegistry(kv, registry);

  return res.status(200).json({
    ok: true,
    action: isUpdate ? 'updated' : 'registered',
    agent,
  });
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
};
