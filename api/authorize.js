/**
 * Early Eagles - POST /api/authorize
 *
 * Step 1 of the mint flow:
 *   1. Verify caller is a Genesis AIBTC agent (level >= 2, ERC-8004)
 *   2. Generate a fresh nonce + an expiry-height a few hundred blocks ahead
 *   3. Return the SIP-018 domain + message tuple the agent must sign
 *
 * The agent then calls mcp__aibtc__sip018_sign({domain, message}) - the
 * mnemonic stays in the wallet vault - and POSTs the resulting signature
 * (plus the nonce + expiry-height) to /api/mint.
 *
 * Wire format for the agent:
 *   {
 *     domain:  { name, version, chainId },
 *     message: { recipient, nonce, expiry-height }
 *   }
 * - matches the JSON shape mcp__aibtc__sip018_sign accepts.
 */

const NFT_CONTRACT = "early-eagles-v2";
const ADMIN_ADDRESS = "SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2";

const SIP018_DOMAIN = {
  name: "early-eagles-v2",
  version: "1",
  chainId: 1, // mainnet
};

// Expiry: stacks-block-height + this many blocks. At Nakamoto cadence
// (~5s/block) 288 blocks is roughly a 24 minute window, which gives an
// agent enough headroom for a slow Hiro response or a wallet-unlock
// retry without forcing a fresh /authorize call.
const EXPIRY_BLOCKS = 288;

const STACKS_API = "https://api.hiro.so";

const CORS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "https://early-eagles.vercel.app",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// -- Rate limiting -----------------------------------------------------------
const RATE_LIMIT_MAP = new Map();
const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS = 10;

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

// -- AIBTC eligibility lookup ------------------------------------------------
// Two parallel fetches, both 5s timeout:
//   1. https://aibtc.com/api/agents/{addr} - JSON API returning level,
//      displayName, btcAddress, bnsName directly (no HTML scraping needed).
//   2. Hiro /extended/v1/tokens/nft/holdings - ground truth for the on-chain
//      ERC-8004 identity. Returns the agent's agentId, independent of any
//      AIBTC backend caching/staleness.
//
// Fallback (bug #896): some agents have a stale STX address in AIBTC's
// registry. If the STX lookup returns not-found but Hiro confirms an
// on-chain ERC-8004 identity, we retrieve the BTC address from the
// identity registry and retry the AIBTC lookup by BTC address.
const IDENTITY_REGISTRY = "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2::agent-identity";
const IDENTITY_REGISTRY_ADDR = "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD";
const IDENTITY_REGISTRY_NAME = "identity-registry-v2";

function timeoutSignal(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

// Resolve BTC address for an agent-id via the on-chain identity registry.
// Returns a bc1q... address string, or null if unavailable.
async function getBtcAddressFromRegistry(agentId) {
  try {
    const idHex = "0x01" + BigInt(agentId).toString(16).padStart(32, "0");
    const r = await fetch(
      STACKS_API + "/v2/contracts/call-read/" + IDENTITY_REGISTRY_ADDR +
      "/" + IDENTITY_REGISTRY_NAME + "/get-agent-wallet",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender: ADMIN_ADDRESS, arguments: [idHex] }),
        signal: timeoutSignal(4000),
      }
    );
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.okay || !d.result) return null;
    // Decode hex → bytes → latin1 string, then scan for a native segwit address.
    const hex = d.result.startsWith("0x") ? d.result.slice(2) : d.result;
    const decoded = Buffer.from(hex, "hex").toString("latin1");
    const m = decoded.match(/bc1[a-z0-9]{25,87}/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

async function fetchAibtcEligibility(stxAddress) {
  const [apiSettled, hiroSettled] = await Promise.allSettled([
    fetch("https://aibtc.com/api/agents/" + stxAddress, {
      headers: { "User-Agent": "EarlyEagles/2.0" },
      signal: timeoutSignal(5000),
    }),
    fetch(
      STACKS_API + "/extended/v1/tokens/nft/holdings?principal=" + stxAddress +
      "&asset_identifiers=" + encodeURIComponent(IDENTITY_REGISTRY),
      { signal: timeoutSignal(5000) }
    ),
  ]);

  // --- Parse Hiro (on-chain identity) first — used for BTC fallback ---
  if (hiroSettled.status === "rejected" || !hiroSettled.value.ok) {
    const detail = hiroSettled.status === "rejected"
      ? hiroSettled.reason.message
      : "HTTP " + hiroSettled.value.status;
    throw new Error("Hiro identity lookup failed: " + detail);
  }
  const hiro = await hiroSettled.value.json();
  const holding = (hiro.results || [])[0];
  const agentId = holding ? parseInt(holding.value.repr.replace(/^u/, ""), 10) : null;
  const resolvedAgentId = Number.isFinite(agentId) ? agentId : null;

  // --- Parse AIBTC profile (STX address path) ---
  let data = null;
  if (apiSettled.status === "fulfilled" && apiSettled.value.ok) {
    const raw = await apiSettled.value.json();
    if (raw && typeof raw.level === "number") data = raw;
  } else if (
    apiSettled.status === "rejected" ||
    (apiSettled.value && apiSettled.value.status !== 404 && !apiSettled.value.ok)
  ) {
    const detail = apiSettled.status === "rejected"
      ? apiSettled.reason.message
      : "HTTP " + apiSettled.value.status;
    throw new Error("AIBTC profile fetch failed: " + detail);
  }

  // --- BTC fallback (bug #896: stale STX in AIBTC registry) ---
  if (!data && resolvedAgentId != null) {
    const btcAddr = await getBtcAddressFromRegistry(resolvedAgentId);
    if (btcAddr) {
      try {
        const btcRes = await fetch("https://aibtc.com/api/agents/" + btcAddr, {
          headers: { "User-Agent": "EarlyEagles/2.0" },
          signal: timeoutSignal(5000),
        });
        if (btcRes.ok) {
          const btcData = await btcRes.json();
          if (btcData && typeof btcData.level === "number") data = btcData;
        }
      } catch { /* ignore — fall through to not-found */ }
    }
  }

  if (!data) {
    return { found: false, reason: "Agent not found on AIBTC network" };
  }

  const agent = data.agent || {};
  return {
    found: true,
    level: data.level,
    levelName: data.levelName || "Unknown",
    displayName: agent.displayName || null,
    btcAddress: agent.btcAddress || null,
    bnsName: agent.bnsName || null,
    agentId: resolvedAgentId,
  };
}

// -- Tip height query --------------------------------------------------------
async function getStacksTipHeight() {
  const r = await fetch(STACKS_API + "/v2/info", { signal: timeoutSignal(5000) });
  if (!r.ok) throw new Error("Hiro /v2/info failed: " + r.status);
  const d = await r.json();
  if (typeof d.stacks_tip_height !== "number") {
    throw new Error("/v2/info missing stacks_tip_height");
  }
  return d.stacks_tip_height;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// -- Handler -----------------------------------------------------------------
module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const clientIp = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown";
  if (!rateLimit(clientIp)) {
    return res.status(429).json({ error: "Too many requests. Try again in 1 minute." });
  }

  const { stxAddress: rawAddr } = req.body || {};
  if (!rawAddr || typeof rawAddr !== "string") {
    return res.status(400).json({ error: "Missing stxAddress" });
  }
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) {
    return res.status(400).json({ error: "Invalid Stacks address format" });
  }

  // Normalize to mainnet SP for AIBTC lookup
  const mainnetAddr = rawAddr.startsWith("ST") ? "SP" + rawAddr.slice(2)
                    : rawAddr.startsWith("SN") ? "SM" + rawAddr.slice(2)
                    : rawAddr;

  // 1. Eligibility: AIBTC level >= 2 AND on-chain ERC-8004 identity
  let eligibility;
  try {
    eligibility = await fetchAibtcEligibility(mainnetAddr);
  } catch (e) {
    return res.status(502).json({ error: "AIBTC eligibility lookup failed: " + e.message });
  }

  if (!eligibility.found) {
    return res.status(403).json({ eligible: false, reason: eligibility.reason });
  }
  if (eligibility.level < 2) {
    return res.status(403).json({
      eligible: false,
      reason: "Not a Genesis agent. Current level: " + eligibility.levelName,
    });
  }
  if (!eligibility.agentId) {
    return res.status(403).json({
      eligible: false,
      reason: "No on-chain ERC-8004 identity. Register at aibtc.com first.",
    });
  }

  // 2. Generate fresh nonce + query tip height for expiry
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  const nonceHex = "0x" + bytesToHex(nonce);

  let tipHeight;
  try {
    tipHeight = await getStacksTipHeight();
  } catch (e) {
    return res.status(502).json({ error: "Stacks tip query failed: " + e.message });
  }
  const expiryHeight = tipHeight + EXPIRY_BLOCKS;

  // 3. Build the SIP-018 domain + message tuple in the JSON shape sip018_sign accepts.
  // The contract reconstructs the same tuple via to-consensus-buff? and verifies the
  // signature with secp256k1-recover? + principal-of?.
  const message = {
    recipient: { type: "principal", value: mainnetAddr },
    nonce: { type: "buffer", value: nonceHex },
    "expiry-height": { type: "uint", value: String(expiryHeight) },
  };

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
      domain: SIP018_DOMAIN,
      message,
      nonce: nonceHex,
      expiryHeight,
      currentHeight: tipHeight,
    },
    instructions:
      "1. Call mcp__aibtc__sip018_sign({domain: auth.domain, message: auth.message}) " +
      "and capture the resulting RSV signature. " +
      "2. POST to /api/mint with {stxAddress, nonce: auth.nonce, " +
      "expiryHeight: auth.expiryHeight, signature: <the sip018_sign result>}. " +
      "Important: send the raw auth.nonce hex string, not auth.message.nonce " +
      "(the message tuple is for sip018_sign, which expects the typed object). " +
      "Same for auth.expiryHeight as a plain number, not auth.message['expiry-height'].",
  });
};
