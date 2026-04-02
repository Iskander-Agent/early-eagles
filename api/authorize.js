/**
 * Early Eagles 🦅 — Vercel Serverless Function: /api/authorize
 * CommonJS for Vercel Node.js runtime compatibility
 */

const AIBTC_API_BASE = "https://aibtc.com/api";
const SIG_EXPIRY_SECONDS = 3600;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function getNoble() {
  const { secp256k1 } = await import("@noble/curves/secp256k1");
  const { keccak_256 } = await import("@noble/hashes/sha3");
  const { bytesToHex, concatBytes } = await import("@noble/hashes/utils");
  return { secp256k1, keccak_256, bytesToHex, concatBytes };
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { stxAddress } = req.body || {};
  if (!stxAddress || typeof stxAddress !== "string") {
    return res.status(400).json({ error: "Missing stxAddress" });
  }
  if (!/^S[PT][A-Z0-9]{38,41}$/.test(stxAddress)) {
    return res.status(400).json({ error: "Invalid Stacks address format" });
  }

  // Check AIBTC API
  let agentData;
  try {
    const apiRes = await fetch(`${AIBTC_API_BASE}/agents/${stxAddress}`, {
      headers: { "User-Agent": "EarlyEagles/1.0" },
    });
    if (!apiRes.ok) {
      if (apiRes.status === 404)
        return res.status(403).json({ eligible: false, reason: "Agent not found on AIBTC network" });
      return res.status(502).json({ error: "AIBTC API error", status: apiRes.status });
    }
    agentData = await apiRes.json();
  } catch (e) {
    return res.status(502).json({ error: "Failed to reach AIBTC API: " + e.message });
  }

  if (!agentData.found || !agentData.agent) {
    return res.status(403).json({ eligible: false, reason: "Agent not found on AIBTC network" });
  }

  const agent = agentData.agent;

  if (!agent.erc8004AgentId) {
    return res.status(403).json({
      eligible: false,
      reason: "No on-chain ERC-8004 identity found. Register at aibtc.com first.",
    });
  }

  if ((agentData.level || 0) < 2) {
    return res.status(403).json({
      eligible: false,
      reason: `Not a Genesis agent. Current level: ${agentData.levelName || agentData.level}. Genesis agents only.`,
    });
  }

  // Build signature
  const rawKey = process.env.SIGNER_PRIVATE_KEY;
  if (!rawKey) return res.status(500).json({ error: "Signer not configured" });
  // Ensure exactly 64 hex chars (pad left if needed)
  const privKeyHex = rawKey.replace(/^0x/, '').padStart(64, '0');

  try {
    const { secp256k1, keccak_256, bytesToHex, concatBytes } = await getNoble();

    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);
    const nonceHex = bytesToHex(nonce);
    const expiry = Math.floor(Date.now() / 1000) + SIG_EXPIRY_SECONDS;

    const addrBytes = new TextEncoder().encode(stxAddress);
    const expiryBuf = new Uint8Array(8);
    new DataView(expiryBuf.buffer).setBigUint64(0, BigInt(expiry), false);

    const message = concatBytes(addrBytes, nonce, expiryBuf);
    const msgHash = keccak_256(message);

    const sig = secp256k1.sign(msgHash, privKeyHex, { lowS: true });
    const sigBytes = sig.toCompactRawBytes();
    const sigFull = new Uint8Array(65);
    sigFull.set(sigBytes, 0);
    sigFull[64] = sig.recovery;

    return res.status(200).json({
      eligible: true,
      agent: {
        stxAddress: agent.stxAddress,
        displayName: agent.displayName,
        bnsName: agent.bnsName || null,
        btcAddress: agent.btcAddress,
        agentId: agent.erc8004AgentId,
        checkInCount: agent.checkInCount,
        level: agentData.levelName,
      },
      auth: {
        nonce: nonceHex,
        expiry,
        signature: bytesToHex(sigFull),
      },
    });
  } catch (e) {
    return res.status(500).json({ error: "Signing failed: " + e.message });
  }
};
