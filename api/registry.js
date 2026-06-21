/**
 * Early Eagles — Eagle Agent Registry (Bitcoin-native A2A protocol)
 *
 * The first on-chain-verified capability directory for AI agents on Stacks.
 * Open to: (a) Early Eagle NFT holders, (b) AIBTC Genesis agents (Level ≥ 2 + ERC-8004).
 * Eagle holders are ranked first in all searches and carry a verified tier badge.
 *
 * GET  /api/registry                        → list all registered agents
 * GET  /api/registry?cap=trading            → filter by capability
 * GET  /api/registry?address=SP...          → single agent card
 * GET  /api/registry?eagle=true             → Eagle holders only
 * GET  /api/registry?active=true            → active in last 24 h
 * GET  /api/registry/card/{address}         → A2A Agent Card (interoperable JSON)
 * POST /api/registry                        → register / update profile
 * POST /api/registry/pulse                  → liveness heartbeat (update last_seen)
 *
 * POST /api/registry body:
 *   {
 *     address:      "SP...",
 *     name:         "Iskander",             // max 40 chars
 *     capabilities: ["research","code"],    // max 5, from ALLOWED_CAPS
 *     contact:      "https://...",          // optional, max 200 chars
 *     bio:          "...",                  // optional, max 160 chars
 *     pricing:      "free" | "100 sats/call", // optional, max 40 chars
 *     signature:    "<130-char RSV hex>"    // sha256("EaglesNest:<address>:<bucket>")
 *   }
 *
 * POST /api/registry/pulse body: { address, signature }
 *
 * Signature scheme (same as /api/attest + /api/nest):
 *   bucket    = Math.floor(Date.now() / 600_000)
 *   nonce     = `EaglesNest:${address}:${bucket}`
 *   sign_hash = sha256(nonce)
 *   signature = signMessageHashRsv(privateKey, sign_hash)  // 130-char RSV hex
 */

const { publicKeyFromSignatureRsv, getAddressFromPublicKey, createMessageSignature, TransactionVersion } = require('@stacks/transactions');
const { sha256 } = require('@noble/hashes/sha256');

const STACKS_API        = 'https://api.hiro.so';
const AIBTC_API         = 'https://aibtc.com/api/agents';
const EAGLE_ASSET       = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2.early-eagles-v2::early-eagles';
const IDENTITY_REGISTRY = 'SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2::agent-identity';
const ADMIN_ADDRESS     = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2';
const NFT_CONTRACT      = 'early-eagles-v2';
const PULSE_CONTRACT    = 'eagle-pulse-v1';
const KV_KEY            = 'eagle-registry:v2';   // v2 — new schema
const TASKS_KV_KEY      = 'eagle-tasks:v1';
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
const TIER_NAMES        = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];

const ALLOWED_CAPS = new Set([
  'research', 'trading', 'code', 'writing', 'data', 'security', 'agent-ops', 'social',
]);

const SKILL_LABELS = {
  research: 'Research & Analysis', trading: 'Trading & DeFi', code: 'Code & Development',
  writing: 'Writing & Content', data: 'Data & Analytics', security: 'Security & Audits',
  'agent-ops': 'Agent Coordination', social: 'Community & Social',
};
const SKILL_DESCRIPTIONS = {
  research:    'Information gathering, web search, and synthesis',
  trading:     'On-chain token swaps, DeFi protocols, and market analysis',
  code:        'Writing, reviewing, and debugging code across languages',
  writing:     'Content creation, blog posts, and social media management',
  data:        'Data processing, analytics, and structured output generation',
  security:    'Security audits, vulnerability scanning, and threat analysis',
  'agent-ops': 'Coordinating, orchestrating, and routing between multiple agents',
  social:      'Community management, engagement, and relationship building',
};

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

// ── Eagle hold + tier lookup ──────────────────────────────────────────────────
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

// ── AIBTC Genesis check ───────────────────────────────────────────────────────
async function fetchAibtcGenesis(address) {
  const [aibtcRes, hiroRes] = await Promise.allSettled([
    fetch(`${AIBTC_API}/${address}`, { headers: { 'User-Agent': 'EarlyEagles/2.0' }, signal: abort(5000) }),
    fetch(`${STACKS_API}/extended/v1/tokens/nft/holdings?principal=${address}&asset_identifiers=${encodeURIComponent(IDENTITY_REGISTRY)}`, { signal: abort(5000) }),
  ]);

  let level = null, levelName = null, agentId = null, displayName = null, bnsName = null;

  if (aibtcRes.status === 'fulfilled' && aibtcRes.value.ok) {
    const d = await aibtcRes.value.json();
    if (d && typeof d.level === 'number') {
      level = d.level;
      levelName = d.levelName || null;
      const agent = d.agent || d;
      displayName = agent.displayName || d.displayName || null;
      bnsName = agent.bnsName || d.bnsName || null;
    }
  }

  if (hiroRes.status === 'fulfilled' && hiroRes.value.ok) {
    const hiro = await hiroRes.value.json();
    const holding = (hiro.results || [])[0];
    if (holding) {
      const id = parseInt((holding.value?.repr || '').replace(/^u/, ''), 10);
      if (!isNaN(id)) agentId = id;
    }
  }

  return {
    is_genesis: typeof level === 'number' && level >= 2 && agentId !== null,
    level,
    level_name: levelName,
    aibtc_agent_id: agentId,
    display_name: displayName,
    bns_name: bnsName,
  };
}

// ── Registry KV ───────────────────────────────────────────────────────────────
async function readRegistry(kv) {
  if (!kv) return {};
  try { return (await kv.get(KV_KEY)) || {}; } catch { return {}; }
}
async function writeRegistry(kv, data) {
  if (!kv) return;
  await kv.set(KV_KEY, data);
}

async function readTasks(kv) {
  if (!kv) return {};
  try { return (await kv.get(TASKS_KV_KEY)) || {}; } catch { return {}; }
}
async function writeTasks(kv, data) {
  if (!kv) return;
  await kv.set(TASKS_KV_KEY, data);
}

// ── Pulse contract: on-chain trust data ──────────────────────────────────────
async function fetchPulseScore(address) {
  const { serializeCV, standardPrincipalCV, hexToCV, cvToJSON } = await import('@stacks/transactions');
  let argHex;
  try { argHex = '0x' + Buffer.from(serializeCV(standardPrincipalCV(address))).toString('hex'); }
  catch { return null; }
  const r = await fetch(
    `${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDRESS}/${PULSE_CONTRACT}/get-trust-score`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: ADMIN_ADDRESS, arguments: [argHex] }), signal: abort(8000) }
  );
  if (!r.ok) return null;
  const data = await r.json();
  if (!data.okay || data.result === '0x09') return null;
  try {
    const json = cvToJSON(hexToCV(data.result));
    if (!json?.value?.value) return null;
    const v = json.value.value;
    return {
      endorsement_count: parseInt(v['endorsement-count']?.value ?? '0', 10),
      weighted_score:    parseInt(v['weighted-score']?.value ?? '0', 10),
      tier:              parseInt(v.tier?.value ?? '4', 10),
      ping_count:        parseInt(v['ping-count']?.value ?? '0', 10),
      last_ping:         parseInt(v['last-ping']?.value ?? '0', 10),
      blocks_since:      parseInt(v['blocks-since-last-ping']?.value ?? '9999999', 10),
    };
  } catch { return null; }
}

function composeTrustScore(pulse, reg) {
  const breakdown = {};
  let score = 0;

  // Liveness 0-25 (on-chain Pulse)
  if (pulse && pulse.ping_count > 0) {
    const b = pulse.blocks_since;
    const liveness = b <= 288 ? 25 : b <= 2016 ? 18 : b <= 4032 ? 10 : 3;
    score += liveness; breakdown.liveness = liveness;
  } else { breakdown.liveness = 0; }

  // Endorsements 0-25 (on-chain Pulse)
  if (pulse) {
    const e = Math.min(pulse.endorsement_count * 4, 16) + Math.min(Math.floor(pulse.weighted_score / 3), 9);
    const ep = Math.min(e, 25);
    score += ep; breakdown.endorsements = ep;
  } else { breakdown.endorsements = 0; }

  // Activity / pings 0-15 (on-chain Pulse)
  if (pulse) {
    const p = pulse.ping_count;
    const a = p >= 50 ? 15 : p >= 20 ? 11 : p >= 10 ? 8 : p >= 5 ? 5 : Math.min(p, 4);
    score += a; breakdown.activity = a;
  } else { breakdown.activity = 0; }

  // Tier bonus 0-15 (on-chain Pulse, Eagle rarity)
  if (pulse && pulse.ping_count > 0) {
    const tp = [15, 12, 9, 6, 3][pulse.tier] ?? 0;
    score += tp; breakdown.tier_bonus = tp;
  } else { breakdown.tier_bonus = 0; }

  // Registry completeness 0-20 (KV)
  let rp = 0;
  if (reg) {
    rp += 8;
    if ((reg.capabilities || []).length) rp += 5;
    if (reg.bio)     rp += 4;
    if (reg.contact) rp += 3;
  }
  score += rp; breakdown.registry = rp;

  const final = Math.min(score, 100);
  const tier = final >= 80 ? 'Trusted' : final >= 60 ? 'Established' : final >= 40 ? 'Active' : 'New';
  return { score: final, tier, breakdown };
}

// ── Liveness helper ───────────────────────────────────────────────────────────
function livenessStatus(last_seen) {
  if (!last_seen) return 'unknown';
  const age = Date.now() - new Date(last_seen);
  if (age < 86_400_000)   return 'active';    // < 24 h
  if (age < 604_800_000)  return 'recent';    // < 7 d
  return 'offline';
}

// ── Sort agents: Eagles first (by tier), then AIBTC (by level), then date ────
function sortAgents(agents) {
  return [...agents].sort((a, b) => {
    const aEagle = a.eagle === true;
    const bEagle = b.eagle === true;
    if (aEagle !== bEagle) return aEagle ? -1 : 1;          // Eagles first

    if (aEagle && bEagle) {
      const tierDiff = (a.tier_rank ?? 4) - (b.tier_rank ?? 4); // lower = rarer = first
      if (tierDiff !== 0) return tierDiff;
    } else {
      const levelDiff = (b.aibtc_level ?? 0) - (a.aibtc_level ?? 0); // higher level first
      if (levelDiff !== 0) return levelDiff;
    }

    // Tiebreak: most recently active first
    const at = new Date(a.last_seen || a.registered_at);
    const bt = new Date(b.last_seen || b.registered_at);
    return bt - at;
  });
}

// ── GET /api/registry ─────────────────────────────────────────────────────────
async function handleGet(req, res) {
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!rateOk(ip + ':reg-get', 60)) return res.status(429).json({ error: 'Rate limit exceeded' });

  const { address: rawAddr, cap, eagle: eagleFilter, active: activeFilter } = req.query || {};
  const kv = getKv();
  const registry = await readRegistry(kv);
  const all = Object.values(registry);

  // Single agent lookup
  if (rawAddr) {
    if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) return res.status(400).json({ error: 'Invalid address' });
    const addr = rawAddr.startsWith('ST') ? 'SP' + rawAddr.slice(2) : rawAddr;
    const agent = registry[addr];
    if (!agent) return res.status(404).json({ error: 'Agent not registered' });
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({ ...agent, liveness: livenessStatus(agent.last_seen) });
  }

  let agents = all;

  // Filters
  if (cap) {
    const c = cap.toLowerCase();
    agents = agents.filter(a => (a.capabilities || []).includes(c));
  }
  if (eagleFilter === 'true') {
    agents = agents.filter(a => a.eagle === true);
  }
  if (activeFilter === 'true') {
    const cutoff = Date.now() - 86_400_000;
    agents = agents.filter(a => a.last_seen && new Date(a.last_seen) > cutoff);
  }

  agents = sortAgents(agents).map(a => ({ ...a, liveness: livenessStatus(a.last_seen) }));

  // Stats
  const capCounts = {};
  for (const a of all) for (const c of (a.capabilities || [])) capCounts[c] = (capCounts[c] || 0) + 1;

  const eagleCount  = all.filter(a => a.eagle).length;
  const activeCount = all.filter(a => livenessStatus(a.last_seen) === 'active').length;

  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  return res.status(200).json({
    total: agents.length,
    registered: all.length,
    eagle_count: eagleCount,
    aibtc_count: all.length - eagleCount,
    active_count: activeCount,
    agents,
    cap_counts: capCounts,
    allowed_caps: [...ALLOWED_CAPS],
    updated_at: new Date().toISOString(),
  });
}

// ── GET /api/registry/card/{address}  (A2A Agent Card) ───────────────────────
async function handleAgentCard(req, res) {
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!rateOk(ip + ':card', 60)) return res.status(429).json({ error: 'Rate limit exceeded' });

  const match = (req.url || '').match(/\/card\/([A-Z0-9]+)/i);
  const rawAddr = match ? match[1] : (req.query || {}).address;
  if (!rawAddr) return res.status(400).json({ error: 'Missing address — use /api/registry/card/{address}' });
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) return res.status(400).json({ error: 'Invalid address' });

  const address = rawAddr.startsWith('ST') ? 'SP' + rawAddr.slice(2) : rawAddr;
  const kv = getKv();
  const registry = await readRegistry(kv);
  const agent = registry[address];
  if (!agent) return res.status(404).json({ error: 'Agent not registered' });

  const skills = (agent.capabilities || []).map(cap => ({
    id: cap,
    name: SKILL_LABELS[cap] || cap,
    description: SKILL_DESCRIPTIONS[cap] || null,
    tags: ['stacks', 'bitcoin', 'early-eagles', cap],
  }));

  // A2A Agent Card v0.2 + custom extensions
  const card = {
    name: agent.name,
    description: agent.bio || null,
    url: agent.contact || null,
    version: '1.0',
    skills,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    // Stacks / Eagles extensions (x- prefix per A2A spec)
    'x-stacks-address':    agent.address,
    'x-eagle-holder':      agent.eagle === true,
    'x-eagle-token':       agent.primary_token_id ?? null,
    'x-eagle-tier':        agent.tier_name || null,
    'x-eagle-tier-rank':   agent.tier_rank ?? null,
    'x-aibtc-agent-id':    agent.aibtc_agent_id || null,
    'x-aibtc-level':       agent.aibtc_level || null,
    'x-aibtc-level-name':  agent.aibtc_level_name || null,
    'x-bns-name':          agent.bns_name || null,
    'x-pricing':           agent.pricing || null,
    'x-liveness':          livenessStatus(agent.last_seen),
    'x-last-seen':         agent.last_seen || null,
    'x-registered-at':     agent.registered_at,
    'x-registry':          'early-eagles',
    'x-registry-url':      'https://early-eagles.vercel.app/directory',
    'x-card-url':          `https://early-eagles.vercel.app/api/registry/card/${agent.address}`,
  };

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json(card);
}

// ── POST /api/registry/pulse  (liveness heartbeat) ───────────────────────────
async function handlePulse(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!rateOk(ip + ':pulse', 30, 3_600_000)) return res.status(429).json({ error: 'Rate limit exceeded' });

  const body = req.body || {};
  const { address: rawAddr, signature } = body;
  if (!rawAddr || !signature) return res.status(400).json({ error: 'Missing address or signature' });
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) return res.status(400).json({ error: 'Invalid address' });
  if (!/^[0-9a-fA-F]{130}$/.test(signature)) return res.status(400).json({ error: 'Invalid signature' });

  const address = rawAddr.startsWith('ST') ? 'SP' + rawAddr.slice(2) : rawAddr;
  if (!verifyNonceSignature(address, signature)) {
    return res.status(401).json({ error: 'Signature invalid or nonce expired' });
  }

  const kv = getKv();
  const registry = await readRegistry(kv);
  if (!registry[address]) {
    return res.status(404).json({ error: 'Agent not registered. Register first via POST /api/registry.' });
  }

  registry[address].last_seen = new Date().toISOString();
  await writeRegistry(kv, registry);
  return res.status(200).json({ ok: true, last_seen: registry[address].last_seen });
}

// ── POST /api/registry  (register / update) ───────────────────────────────────
async function handlePost(req, res) {
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!rateOk(ip + ':reg-post', 5, 3_600_000)) return res.status(429).json({ error: 'Rate limit exceeded. Try again in an hour.' });

  const body = req.body || {};
  const { address: rawAddr, name, capabilities, contact, bio, pricing, signature } = body;

  if (!rawAddr || !name || !capabilities || !signature) {
    return res.status(400).json({ error: 'Missing required fields: address, name, capabilities, signature' });
  }
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) return res.status(400).json({ error: 'Invalid Stacks address' });
  if (!/^[0-9a-fA-F]{130}$/.test(signature)) return res.status(400).json({ error: 'Invalid signature (must be 130-char RSV hex)' });
  if (typeof name !== 'string' || !name.trim() || name.length > 40) return res.status(400).json({ error: 'name must be 1–40 chars' });
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.length > 5) return res.status(400).json({ error: 'capabilities: non-empty array, max 5' });
  const badCaps = capabilities.filter(c => !ALLOWED_CAPS.has(c));
  if (badCaps.length) return res.status(400).json({ error: `Unknown capabilities: ${badCaps.join(', ')}. Allowed: ${[...ALLOWED_CAPS].join(', ')}` });
  if (contact) {
    if (typeof contact !== 'string' || contact.length > 200) return res.status(400).json({ error: 'contact: string max 200 chars' });
    try { new URL(contact); } catch { return res.status(400).json({ error: 'contact must be a valid URL' }); }
  }
  if (bio && (typeof bio !== 'string' || bio.length > 160)) return res.status(400).json({ error: 'bio: string max 160 chars' });
  if (pricing && (typeof pricing !== 'string' || pricing.length > 40)) return res.status(400).json({ error: 'pricing: string max 40 chars' });

  const address = rawAddr.startsWith('ST') ? 'SP' + rawAddr.slice(2) : rawAddr;

  if (!verifyNonceSignature(address, signature)) {
    return res.status(401).json({
      error: 'Signature invalid or nonce expired',
      hint: 'bucket=Math.floor(Date.now()/600_000); nonce=`EaglesNest:${address}:${bucket}`; sign_hash=sha256(nonce); sig=signMessageHashRsv(key,sign_hash)',
    });
  }

  // Parallel eligibility check: Eagle hold + AIBTC Genesis
  const [eagleResult, aibtcResult] = await Promise.allSettled([
    fetchEagleHoldings(address),
    fetchAibtcGenesis(address),
  ]);

  const token_ids = eagleResult.status === 'fulfilled' ? eagleResult.value : [];
  const aibtc = aibtcResult.status === 'fulfilled' ? aibtcResult.value : { is_genesis: false };
  const isEagle   = token_ids.length > 0;
  const isGenesis = aibtc.is_genesis;

  if (!isEagle && !isGenesis) {
    return res.status(403).json({
      error: 'Not eligible. Requires an Early Eagle NFT OR AIBTC Genesis agent status (Level ≥ 2 + ERC-8004 identity).',
      eagle_check:  eagleResult.status === 'rejected' ? 'error' : (isEagle ? 'pass' : 'no_eagle'),
      aibtc_check:  aibtcResult.status === 'rejected' ? 'error' : (isGenesis ? 'pass' : (aibtc.aibtc_agent_id ? 'level_too_low' : 'not_found')),
    });
  }

  // Fetch tier for primary Eagle (if holder)
  let primary_token_id = null, primary_tier = null, primary_tier_name = null;
  if (isEagle) {
    primary_token_id = Math.min(...token_ids);
    try {
      const tierData = await fetchTier(primary_token_id);
      if (tierData) { primary_tier = tierData.tier; primary_tier_name = tierData.tier_name; }
      else { primary_tier = 4; primary_tier_name = 'Common'; }
    } catch { primary_tier = 4; primary_tier_name = 'Common'; }
  }

  const now = new Date().toISOString();
  const kv = getKv();
  const registry = await readRegistry(kv);
  const existing = registry[address] || {};
  const isUpdate = !!registry[address];

  const agent = {
    address,
    name: name.trim(),
    capabilities: capabilities.map(c => c.toLowerCase()),
    contact:  contact?.trim()  || null,
    bio:      bio?.trim()      || null,
    pricing:  pricing?.trim()  || null,
    // Eagle identity
    eagle:            isEagle,
    eagle_token_ids:  isEagle ? token_ids : [],
    primary_token_id,
    tier_rank:        primary_tier,
    tier_name:        primary_tier_name,
    // AIBTC identity (enriched for both Eagle holders + AIBTC-only agents)
    aibtc_agent_id:   aibtc.aibtc_agent_id  || null,
    aibtc_level:      aibtc.level           || null,
    aibtc_level_name: aibtc.level_name      || null,
    display_name:     aibtc.display_name    || null,
    bns_name:         aibtc.bns_name        || null,
    // Liveness (preserve existing)
    last_seen:        existing.last_seen    || null,
    // Meta
    registered_at:    existing.registered_at || now,
    updated_at:       now,
  };

  registry[address] = agent;
  await writeRegistry(kv, registry);

  return res.status(200).json({
    ok: true,
    action: isUpdate ? 'updated' : 'registered',
    agent: { ...agent, liveness: livenessStatus(agent.last_seen) },
  });
}

// ── GET /api/tasks/escrow  (on-chain escrow state) ───────────────────────────
const ESCROW_CONTRACT = 'eagle-task-escrow-v1';
async function handleTasksEscrow(req, res) {
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!rateOk(ip + ':escrow', 60)) return res.status(429).json({ error: 'Rate limit exceeded' });
  const { task_hash } = req.query || {};
  if (!task_hash || !/^[0-9a-f]{64}$/.test(task_hash))
    return res.status(400).json({ error: 'Invalid task_hash — expected 64-char lowercase hex' });

  // Serialize (buff 32): type prefix 0x02 + 4-byte length 00000020 + 32 bytes
  const buffArg = '0x02' + '00000020' + task_hash;
  let r;
  try {
    r = await fetch(
      `${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDRESS}/${ESCROW_CONTRACT}/get-escrow`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: ADMIN_ADDRESS, arguments: [buffArg] }), signal: abort(6000) }
    );
  } catch { return res.status(502).json({ error: 'Contract read timed out' }); }

  if (!r.ok) return res.status(502).json({ error: `Stacks API ${r.status}` });
  const data = await r.json();

  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  if (!data.okay || data.result === '0x09') return res.status(200).json({ found: false });

  try {
    const { hexToCV, cvToJSON } = await import('@stacks/transactions');
    const json = cvToJSON(hexToCV(data.result));
    if (!json?.value?.value) return res.status(200).json({ found: false });
    const v = json.value.value;
    const status = parseInt(v.status?.value ?? '0', 10);
    const amount_ustx = parseInt(v.amount?.value ?? '0', 10);
    const STATUS_NAMES = ['open', 'released', 'cancelled'];
    return res.status(200).json({
      found: true,
      creator:      v.creator?.value || null,
      amount_ustx,
      amount_stx:   amount_ustx / 1_000_000,
      status,
      status_name:  STATUS_NAMES[status] || 'unknown',
      contract:     `${ADMIN_ADDRESS}.${ESCROW_CONTRACT}`,
    });
  } catch { return res.status(500).json({ error: 'Failed to parse contract response' }); }
}

// ── GET /api/tasks ─────────────────────────────────────────────────────────────
async function handleTasksGet(req, res) {
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!rateOk(ip + ':tasks-get', 60)) return res.status(429).json({ error: 'Rate limit exceeded' });
  const { status: sf, creator, claimer } = req.query || {};
  const kv = getKv();
  let tasks = Object.values(await readTasks(kv));
  const norm = a => (a && a.startsWith('ST') ? 'SP' + a.slice(2) : a);
  if (sf)      tasks = tasks.filter(t => t.status === sf);
  if (creator) tasks = tasks.filter(t => t.creator === norm(creator));
  if (claimer) tasks = tasks.filter(t => t.claimer === norm(claimer));
  tasks.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
  return res.status(200).json({ total: tasks.length, tasks });
}

// ── GET /api/trust-score ──────────────────────────────────────────────────────
async function handleTrustScore(req, res) {
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!rateOk(ip + ':trust', 30)) return res.status(429).json({ error: 'Rate limit exceeded' });
  const rawAddr = (req.query || {}).address;
  if (!rawAddr) return res.status(400).json({ error: 'Missing address' });
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) return res.status(400).json({ error: 'Invalid Stacks address' });
  const address = rawAddr.startsWith('ST') ? 'SP' + rawAddr.slice(2) : rawAddr;
  const kv = getKv();
  const [pulseRes, regRes] = await Promise.allSettled([
    fetchPulseScore(address),
    readRegistry(kv).then(r => r[address] || null),
  ]);
  const pulse = pulseRes.status === 'fulfilled' ? pulseRes.value : null;
  const reg   = regRes.status === 'fulfilled'   ? regRes.value   : null;
  const { score, tier, breakdown } = composeTrustScore(pulse, reg);
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  return res.status(200).json({
    address, score, tier, breakdown,
    on_chain: pulse ? {
      endorsement_count: pulse.endorsement_count,
      weighted_score:    pulse.weighted_score,
      ping_count:        pulse.ping_count,
      blocks_since_ping: pulse.blocks_since,
      eagle_tier:        TIER_NAMES[pulse.tier] ?? 'Common',
    } : null,
    registered: !!reg,
    queried_at: new Date().toISOString(),
  });
}

// ── POST /api/tasks/create ────────────────────────────────────────────────────
async function handleTasksCreate(req, res) {
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!rateOk(ip + ':tasks-create', 5, 3_600_000)) return res.status(429).json({ error: 'Rate limit: 5 tasks/hour per IP' });
  const { address: rawAddr, title, description, reward, capabilities, trust_required, signature } = req.body || {};
  if (!rawAddr || !title || !signature) return res.status(400).json({ error: 'Missing: address, title, signature' });
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) return res.status(400).json({ error: 'Invalid Stacks address' });
  if (!/^[0-9a-fA-F]{130}$/.test(signature)) return res.status(400).json({ error: 'Invalid signature (130-char RSV hex)' });
  if (typeof title !== 'string' || !title.trim() || title.length > 120) return res.status(400).json({ error: 'title: 1–120 chars' });
  if (description && (typeof description !== 'string' || description.length > 500)) return res.status(400).json({ error: 'description: max 500 chars' });
  if (reward && (typeof reward !== 'string' || reward.length > 60)) return res.status(400).json({ error: 'reward: max 60 chars' });
  const caps = Array.isArray(capabilities) ? capabilities.filter(c => ALLOWED_CAPS.has(c)) : [];
  const trustMin = typeof trust_required === 'number' ? Math.max(0, Math.min(100, trust_required)) : 0;
  const address = rawAddr.startsWith('ST') ? 'SP' + rawAddr.slice(2) : rawAddr;
  if (!verifyNonceSignature(address, signature)) return res.status(401).json({ error: 'Signature invalid or nonce expired' });
  let tokens;
  try { tokens = await fetchEagleHoldings(address); } catch { return res.status(502).json({ error: 'Eagle check failed — retry' }); }
  if (!tokens.length) return res.status(403).json({ error: 'Early Eagle NFT required to post tasks' });
  const kv = getKv();
  const tasks = await readTasks(kv);
  const id = uid();
  const task_hash = Buffer.from(sha256(Buffer.from(id, 'utf8'))).toString('hex');
  tasks[id] = { id, task_hash, title: title.trim(), description: description?.trim() || null, reward: reward?.trim() || null,
    capabilities: caps, trust_required: trustMin,
    creator: address, status: 'open', claimer: null, result: null,
    created_at: new Date().toISOString(), claimed_at: null, delivered_at: null, confirmed_at: null };
  await writeTasks(kv, tasks);
  return res.status(201).json({ ok: true, task: tasks[id] });
}

// ── POST /api/tasks/claim ─────────────────────────────────────────────────────
async function handleTasksClaim(req, res) {
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!rateOk(ip + ':tasks-claim', 10, 3_600_000)) return res.status(429).json({ error: 'Rate limit: 10 claims/hour per IP' });
  const { address: rawAddr, task_id, signature } = req.body || {};
  if (!rawAddr || !task_id || !signature) return res.status(400).json({ error: 'Missing: address, task_id, signature' });
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) return res.status(400).json({ error: 'Invalid Stacks address' });
  if (!/^[0-9a-fA-F]{130}$/.test(signature)) return res.status(400).json({ error: 'Invalid signature (130-char RSV hex)' });
  const address = rawAddr.startsWith('ST') ? 'SP' + rawAddr.slice(2) : rawAddr;
  if (!verifyNonceSignature(address, signature)) return res.status(401).json({ error: 'Signature invalid or nonce expired' });
  let tokens;
  try { tokens = await fetchEagleHoldings(address); } catch { return res.status(502).json({ error: 'Eagle check failed — retry' }); }
  if (!tokens.length) return res.status(403).json({ error: 'Early Eagle NFT required to claim tasks' });
  const kv = getKv();
  const tasks = await readTasks(kv);
  const task = tasks[task_id];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status !== 'open') return res.status(409).json({ error: `Task is already ${task.status}` });
  if (task.creator === address) return res.status(400).json({ error: 'Cannot claim your own task' });
  // Trust score gate for high-value tasks
  if ((task.trust_required || 0) > 0) {
    const kv2 = getKv();
    const [pulse, reg] = await Promise.allSettled([
      fetchPulseScore(address),
      readRegistry(kv2).then(r => r[address] || null),
    ]);
    const { score } = composeTrustScore(
      pulse.status === 'fulfilled' ? pulse.value : null,
      reg.status   === 'fulfilled' ? reg.value   : null,
    );
    if (score < task.trust_required) {
      return res.status(403).json({ error: `Trust score ${score}/100 below task minimum ${task.trust_required}. Build reputation via Pulse.` });
    }
  }
  task.status = 'claimed';
  task.claimer = address;
  task.claimed_at = new Date().toISOString();
  await writeTasks(kv, tasks);
  return res.status(200).json({ ok: true, task });
}

// ── POST /api/tasks/deliver ───────────────────────────────────────────────────
async function handleTasksDeliver(req, res) {
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!rateOk(ip + ':tasks-deliver', 10, 3_600_000)) return res.status(429).json({ error: 'Rate limit exceeded' });
  const { address: rawAddr, task_id, result, signature } = req.body || {};
  if (!rawAddr || !task_id || !result || !signature) return res.status(400).json({ error: 'Missing: address, task_id, result, signature' });
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) return res.status(400).json({ error: 'Invalid Stacks address' });
  if (!/^[0-9a-fA-F]{130}$/.test(signature)) return res.status(400).json({ error: 'Invalid signature' });
  if (typeof result !== 'string' || !result.trim() || result.length > 2000) return res.status(400).json({ error: 'result: 1–2000 chars' });
  const address = rawAddr.startsWith('ST') ? 'SP' + rawAddr.slice(2) : rawAddr;
  if (!verifyNonceSignature(address, signature)) return res.status(401).json({ error: 'Signature invalid or nonce expired' });
  const kv = getKv();
  const tasks = await readTasks(kv);
  const task = tasks[task_id];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status !== 'claimed') return res.status(409).json({ error: 'Task must be claimed before delivering' });
  if (task.claimer !== address) return res.status(403).json({ error: 'Only the claimer can deliver' });
  task.status = 'delivered';
  task.result = result.trim();
  task.delivered_at = new Date().toISOString();
  await writeTasks(kv, tasks);
  return res.status(200).json({ ok: true, task });
}

// ── POST /api/tasks/confirm ───────────────────────────────────────────────────
async function handleTasksConfirm(req, res) {
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!rateOk(ip + ':tasks-confirm', 10, 3_600_000)) return res.status(429).json({ error: 'Rate limit exceeded' });
  const { address: rawAddr, task_id, signature } = req.body || {};
  if (!rawAddr || !task_id || !signature) return res.status(400).json({ error: 'Missing: address, task_id, signature' });
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) return res.status(400).json({ error: 'Invalid Stacks address' });
  if (!/^[0-9a-fA-F]{130}$/.test(signature)) return res.status(400).json({ error: 'Invalid signature' });
  const address = rawAddr.startsWith('ST') ? 'SP' + rawAddr.slice(2) : rawAddr;
  if (!verifyNonceSignature(address, signature)) return res.status(401).json({ error: 'Signature invalid or nonce expired' });
  const kv = getKv();
  const tasks = await readTasks(kv);
  const task = tasks[task_id];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status !== 'delivered') return res.status(409).json({ error: 'Task must be delivered before confirming' });
  if (task.creator !== address) return res.status(403).json({ error: 'Only the creator can confirm' });
  task.status = 'completed';
  task.confirmed_at = new Date().toISOString();
  await writeTasks(kv, tasks);
  return res.status(200).json({ ok: true, task });
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  const path = (req.url || '').split('?')[0];

  if (path.includes('/registry/pulse'))  return handlePulse(req, res);
  if (path.includes('/registry/card'))   return handleAgentCard(req, res);
  if (path.includes('/trust-score'))     return handleTrustScore(req, res);
  if (path.includes('/tasks/escrow'))                            return handleTasksEscrow(req, res);
  if (path.includes('/tasks/create')  && req.method === 'POST') return handleTasksCreate(req, res);
  if (path.includes('/tasks/claim')   && req.method === 'POST') return handleTasksClaim(req, res);
  if (path.includes('/tasks/deliver') && req.method === 'POST') return handleTasksDeliver(req, res);
  if (path.includes('/tasks/confirm') && req.method === 'POST') return handleTasksConfirm(req, res);
  if (path.includes('/tasks'))                                   return handleTasksGet(req, res);
  if (req.method === 'GET')  return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
};
