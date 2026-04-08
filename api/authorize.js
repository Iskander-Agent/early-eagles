/**
 * Early Eagles — POST /api/authorize
 *
 * Step 1 of the mint flow:
 * 1. Verify caller is a Genesis AIBTC agent (level >= 2, ERC-8004)
 * 2. Generate random nonce + expiry
 * 3. Compute the message hash the agent must sign for on-chain consent
 * 4. Return auth data so agent can sign and call /api/mint
 *
 * Message format (matches contract's admin-mint verification):
 *   keccak256(to-consensus-buff?(principal) || nonce_16 || expiry_8)
 *   to-consensus-buff? = 0x05 + version(1) + hash160(20) = 22 bytes
 */

const AIBTC_API_BASE = 'https://aibtc.com/api';
const SIG_EXPIRY_SECONDS = 3600; // 1 hour

const CORS = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || 'https://early-eagles.vercel.app',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};


// ── Rate limiting ─────────────────────────────────────────────────────────────
const RATE_LIMIT_MAP = new Map();
const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS = 10; // more generous than mint — this is just a lookup

function rateLimit(ip) {
  const now = Date.now();
  const entry = RATE_LIMIT_MAP.get(ip);
  if (!entry || now > entry.resetAt) {
    RATE_LIMIT_MAP.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_REQUESTS) return false;
  entry.count++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of RATE_LIMIT_MAP) {
    if (now > v.resetAt) RATE_LIMIT_MAP.delete(k);
  }
}, 300_000);

// C32 alphabet for Stacks address decoding
const C32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function decodeStacksAddress(addr) {
  const body = addr.slice(2);
  let n = BigInt(0);
  for (const ch of body) {
    const idx = C32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid c32 char: ' + ch);
    n = n * 32n + BigInt(idx);
  }
  const bytes = [];
  let tmp = n;
  for (let i = 0; i < 25; i++) {
    bytes.unshift(Number(tmp & 0xffn));
    tmp >>= 8n;
  }
  return { version: bytes[0], hash160: bytes.slice(1, 21) };
}

// Build Clarity consensus bytes for a standard principal
// Result: 0x05 + version(1) + hash160(20) = 22 bytes
function principalConsensusBytes(stxAddress) {
  const { version, hash160 } = decodeStacksAddress(stxAddress);
  const buf = new Uint8Array(22);
  buf[0] = 0x05;
  buf[1] = version;
  buf.set(hash160, 2);
  return buf;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const clientIp = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
  if (!rateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many requests. Try again in 1 minute.' });
  }

  const { stxAddress: rawAddr } = req.body || {};
  if (!rawAddr || typeof rawAddr !== 'string') {
    return res.status(400).json({ error: 'Missing stxAddress' });
  }
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) {
    return res.status(400).json({ error: 'Invalid Stacks address format' });
  }

  // Normalize to mainnet SP for AIBTC lookup
  const mainnetAddr = rawAddr.startsWith('ST') ? 'SP' + rawAddr.slice(2)
                    : rawAddr.startsWith('SN') ? 'SM' + rawAddr.slice(2)
                    : rawAddr;

  // 1. Check AIBTC agent status
  let agentData;
  try {
    const apiRes = await fetch(AIBTC_API_BASE + '/agents/' + mainnetAddr, {
      headers: { 'User-Agent': 'EarlyEagles/2.0' },
    });
    if (!apiRes.ok) {
      if (apiRes.status === 404) return res.status(403).json({ eligible: false, reason: 'Agent not found on AIBTC network' });
      return res.status(502).json({ error: 'AIBTC API error', status: apiRes.status });
    }
    agentData = await apiRes.json();
  } catch (e) {
    return res.status(502).json({ error: 'Failed to reach AIBTC API: ' + e.message });
  }

  if (!agentData.found || !agentData.agent) {
    return res.status(403).json({ eligible: false, reason: 'Agent not found on AIBTC network' });
  }
  const agent = agentData.agent;

  if (!agent.erc8004AgentId) {
    return res.status(403).json({ eligible: false, reason: 'No on-chain ERC-8004 identity. Register at aibtc.com first.' });
  }
  if ((agentData.level || 0) < 2) {
    return res.status(403).json({ eligible: false, reason: 'Not a Genesis agent. Current level: ' + (agentData.levelName || agentData.level) });
  }

  // 2. Generate nonce + expiry
  const { keccak_256 } = await import('@noble/hashes/sha3');

  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);

  const expiryTs = Math.floor(Date.now() / 1000) + SIG_EXPIRY_SECONDS;
  const expiryBuf = new Uint8Array(8);
  new DataView(expiryBuf.buffer).setBigUint64(0, BigInt(expiryTs), false);

  // 3. Compute the message hash agent must sign
  // Matches contract: keccak256(to-consensus-buff?(recipient) || nonce || expiry-buff)
  const principalBytes = principalConsensusBytes(mainnetAddr);
  const message = new Uint8Array(22 + 16 + 8); // 46 bytes
  message.set(principalBytes, 0);
  message.set(nonce, 22);
  message.set(expiryBuf, 38);
  const messageHash = keccak_256(message);

  return res.status(200).json({
    eligible: true,
    agent: {
      stxAddress: mainnetAddr,
      displayName: agent.displayName,
      bnsName: agent.bnsName || null,
      btcAddress: agent.btcAddress,
      agentId: parseInt(agent.erc8004AgentId, 10),
      level: agentData.levelName,
    },
    auth: {
      nonce: bytesToHex(nonce),
      expiryBuff: bytesToHex(expiryBuf),
      expiryTs,
      messageHash: bytesToHex(messageHash),
    },
    instructions: 'Sign messageHash with your STX private key (secp256k1), then POST to /api/mint with {stxAddress, nonce, expiryBuff, agentSignature}',
  });
};
