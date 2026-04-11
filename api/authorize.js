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

// ── AIBTC eligibility lookup ──────────────────────────────────────────────────
// Replaces the legacy https://aibtc.com/api/agents/{addr} call, which reliably
// hangs upstream for real Genesis agents (>15s, 0 bytes — confirmed against
// multiple addresses). Two parallel fetches, both 5s timeout:
//   1. https://aibtc.com/agents/{addr} — public RSC HTML page. Contains level,
//      displayName, btcAddress, bnsName as escaped JSON in __next_f.push blocks.
//   2. Hiro /extended/v1/tokens/nft/holdings — ground truth for ERC-8004
//      identity. Returns the agent's on-chain agentId, independent of any
//      AIBTC backend caching/staleness.
const IDENTITY_REGISTRY = 'SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2::agent-identity';

function timeoutSignal(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

async function fetchAibtcEligibility(stxAddress) {
  const [pageSettled, hiroSettled] = await Promise.allSettled([
    fetch('https://aibtc.com/agents/' + stxAddress, {
      headers: { 'User-Agent': 'EarlyEagles/2.0' },
      signal: timeoutSignal(5000),
    }),
    fetch(
      'https://api.hiro.so/extended/v1/tokens/nft/holdings?principal=' + stxAddress +
      '&asset_identifiers=' + encodeURIComponent(IDENTITY_REGISTRY),
      { signal: timeoutSignal(5000) }
    ),
  ]);

  if (pageSettled.status === 'rejected' || !pageSettled.value.ok) {
    const detail = pageSettled.status === 'rejected'
      ? pageSettled.reason.message
      : 'HTTP ' + pageSettled.value.status;
    throw new Error('AIBTC profile fetch failed: ' + detail);
  }
  if (hiroSettled.status === 'rejected' || !hiroSettled.value.ok) {
    const detail = hiroSettled.status === 'rejected'
      ? hiroSettled.reason.message
      : 'HTTP ' + hiroSettled.value.status;
    throw new Error('Hiro identity lookup failed: ' + detail);
  }

  const html = await pageSettled.value.text();
  const hiro = await hiroSettled.value.json();

  // Parse fields from RSC payload (escaped JSON inside HTML).
  const levelMatch = html.match(/level\\":(\d+)/);
  if (!levelMatch) {
    return { found: false, reason: 'Agent not found on AIBTC network' };
  }
  const levelNameMatch = html.match(/levelName\\":\\"([A-Za-z]+)/);
  const displayNameMatch = html.match(/displayName\\":\\"([^"\\]+)/);
  const btcAddrMatch = html.match(/btcAddress\\":\\"([a-zA-Z0-9]+)/);
  const bnsMatch = html.match(/bnsName\\":\\"([^"\\]+)/);

  // ERC-8004 agentId from Hiro NFT holdings.
  // value.repr is Clarity uint serialization, e.g. "u124".
  const holding = (hiro.results || [])[0];
  const agentId = holding ? parseInt(holding.value.repr.replace(/^u/, ''), 10) : null;

  return {
    found: true,
    level: parseInt(levelMatch[1], 10),
    levelName: levelNameMatch ? levelNameMatch[1] : 'Unknown',
    displayName: displayNameMatch ? displayNameMatch[1] : null,
    btcAddress: btcAddrMatch ? btcAddrMatch[1] : null,
    bnsName: bnsMatch ? bnsMatch[1] : null,
    agentId: Number.isFinite(agentId) ? agentId : null,
  };
}

// Principal consensus serialization (matches Clarity to-consensus-buff?)
// Standard principal: type 0x05 || version (1 byte) || hash160 (20 bytes) = 22 bytes.
// Must match Clarity's to-consensus-buff? exactly so signatures verify on-chain.
//
// Earlier versions had a hand-rolled c32 decoder that returned the wrong version
// byte (0x00 instead of 0x16/0x1a). The bug was discovered during the testnet
// rehearsal of admin-mint and fixed by switching to the canonical c32check
// library which is already pinned via @stacks/transactions.
async function principalConsensusBytes(stxAddress) {
  const { c32addressDecode } = await import("c32check");
  const [version, hash160Hex] = c32addressDecode(stxAddress);
  const buf = new Uint8Array(22);
  buf[0] = 0x05;
  buf[1] = version;
  for (let i = 0; i < 20; i++) {
    buf[2 + i] = parseInt(hash160Hex.slice(i * 2, i * 2 + 2), 16);
  }
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

  // 1. Eligibility: AIBTC level >= 2 AND on-chain ERC-8004 identity.
  let eligibility;
  try {
    eligibility = await fetchAibtcEligibility(mainnetAddr);
  } catch (e) {
    return res.status(502).json({ error: 'AIBTC eligibility lookup failed: ' + e.message });
  }

  if (!eligibility.found) {
    return res.status(403).json({ eligible: false, reason: eligibility.reason });
  }
  if (eligibility.level < 2) {
    return res.status(403).json({ eligible: false, reason: 'Not a Genesis agent. Current level: ' + eligibility.levelName });
  }
  if (!eligibility.agentId) {
    return res.status(403).json({ eligible: false, reason: 'No on-chain ERC-8004 identity. Register at aibtc.com first.' });
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
  const principalBytes = await principalConsensusBytes(mainnetAddr);
  const message = new Uint8Array(22 + 16 + 8); // 46 bytes
  message.set(principalBytes, 0);
  message.set(nonce, 22);
  message.set(expiryBuf, 38);
  const messageHash = keccak_256(message);

  return res.status(200).json({
    eligible: true,
    agent: {
      stxAddress: mainnetAddr,
      displayName: eligibility.displayName,
      bnsName: eligibility.bnsName,
      btcAddress: eligibility.btcAddress,
      agentId: eligibility.agentId,
      level: eligibility.levelName,
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
