/**
 * Early Eagles - GET /api/eligibility?address=SP...
 *
 * Lightweight eligibility check — no nonce generation, no auth tokens.
 * Returns agent info + eligibility status + whether already minted.
 */

const ADMIN_ADDRESS = "SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2";
const CONTRACT_NAME = "early-eagles-v2";
const STACKS_API = "https://api.hiro.so";
const IDENTITY_REGISTRY = "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2::agent-identity";

const CORS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "https://early-eagles.vercel.app",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Rate limiting: 20 req / 60s per IP (generous — read-only)
const RATE_MAP = new Map();
const RATE_WINDOW = 60_000;
const MAX_REQ = 20;

function rateOk(ip) {
  const now = Date.now();
  const e = RATE_MAP.get(ip);
  if (!e || now > e.r) { RATE_MAP.set(ip, { c: 1, r: now + RATE_WINDOW }); return true; }
  if (e.c >= MAX_REQ) return false;
  e.c++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of RATE_MAP) if (now > v.r) RATE_MAP.delete(k);
}, 300_000);

function sig(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

// Check if address already minted (read-only contract call)
async function checkAlreadyMinted(addr) {
  try {
    const url = `${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDRESS}/${CONTRACT_NAME}/get-mint-stats`;
    // We actually need to check minted-wallets map — but that's not exposed as a function.
    // Instead, use the map lookup via data-var endpoint or call a read-only if available.
    // The contract has: (map-get? minted-wallets {addr: recipient})
    // We can't call map-get directly via API. Let's check via Hiro NFT holdings instead.
    const r = await fetch(
      `${STACKS_API}/extended/v1/tokens/nft/holdings?principal=${addr}` +
      `&asset_identifiers=${encodeURIComponent(ADMIN_ADDRESS + "." + CONTRACT_NAME + "::early-eagle")}`,
      { signal: sig(5000) }
    );
    if (!r.ok) return null; // unknown
    const d = await r.json();
    return (d.results || []).length > 0;
  } catch {
    return null; // unknown, don't block
  }
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const clientIp = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown";
  if (!rateOk(clientIp)) {
    return res.status(429).json({ error: "Too many requests. Try again in 1 minute." });
  }

  const rawAddr = (req.query || {}).address;
  if (!rawAddr || typeof rawAddr !== "string") {
    return res.status(400).json({ error: "Missing ?address= parameter" });
  }
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) {
    return res.status(400).json({ error: "Invalid Stacks address format" });
  }

  const mainnetAddr = rawAddr.startsWith("ST") ? "SP" + rawAddr.slice(2)
                    : rawAddr.startsWith("SN") ? "SM" + rawAddr.slice(2)
                    : rawAddr;

  // Parallel: AIBTC profile + Hiro identity + already-minted check
  const [apiRes, hiroRes, minted] = await Promise.allSettled([
    fetch("https://aibtc.com/api/agents/" + mainnetAddr, {
      headers: { "User-Agent": "EarlyEagles/2.0" },
      signal: sig(5000),
    }),
    fetch(
      `${STACKS_API}/extended/v1/tokens/nft/holdings?principal=${mainnetAddr}` +
      `&asset_identifiers=${encodeURIComponent(IDENTITY_REGISTRY)}`,
      { signal: sig(5000) }
    ),
    checkAlreadyMinted(mainnetAddr),
  ]);

  // Build result
  const result = {
    address: mainnetAddr,
    eligible: false,
    reason: null,
    agent: null,
    alreadyMinted: minted.status === "fulfilled" ? minted.value : null,
  };

  // AIBTC profile
  if (apiRes.status === "rejected" || !apiRes.value.ok) {
    if (apiRes.status === "fulfilled" && apiRes.value.status === 404) {
      result.reason = "Agent not found on AIBTC network";
      return res.status(200).json(result);
    }
    result.reason = "AIBTC lookup failed — try again shortly";
    return res.status(200).json(result);
  }

  const data = await apiRes.value.json();
  if (!data || typeof data.level !== "number") {
    result.reason = "Agent not found on AIBTC network";
    return res.status(200).json(result);
  }

  const agent = data.agent || {};
  result.agent = {
    displayName: agent.displayName || null,
    bnsName: agent.bnsName || null,
    btcAddress: agent.btcAddress || null,
    level: data.level,
    levelName: data.levelName || "Unknown",
  };

  // Level check
  if (data.level < 2) {
    result.reason = `Not a Genesis agent (current level: ${data.levelName || data.level})`;
    return res.status(200).json(result);
  }

  // ERC-8004 identity
  if (hiroRes.status === "rejected" || !hiroRes.value.ok) {
    result.reason = "Identity lookup failed — try again shortly";
    return res.status(200).json(result);
  }

  const hiro = await hiroRes.value.json();
  const holding = (hiro.results || [])[0];
  const agentId = holding ? parseInt(holding.value.repr.replace(/^u/, ""), 10) : null;

  if (!agentId && agentId !== 0) {
    result.reason = "No on-chain ERC-8004 identity found";
    return res.status(200).json(result);
  }

  result.agent.agentId = agentId;
  result.eligible = true;

  if (result.alreadyMinted) {
    result.reason = "Already minted — each agent can only mint once";
  }

  return res.status(200).json(result);
};
