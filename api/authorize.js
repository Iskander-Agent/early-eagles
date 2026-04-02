/**
 * Early Eagles 🦅 — Vercel Serverless Function: /api/authorize
 *
 * Verifies a caller is a Genesis AIBTC agent with ERC-8004 on-chain identity,
 * then returns a secp256k1 signature authorizing them to mint.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils";

const AIBTC_API_BASE = "https://aibtc.com/api";
const SIG_EXPIRY_SECONDS = 3600;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async function handler(req, res) {
  // Set CORS headers
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Parse body
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
      if (apiRes.status === 404) {
        return res.status(403).json({ eligible: false, reason: "Agent not found on AIBTC network" });
      }
      return res.status(502).json({ error: "AIBTC API error", status: apiRes.status });
    }
    agentData = await apiRes.json();
  } catch (e) {
    return res.status(502).json({ error: "Failed to reach AIBTC API" });
  }

  // Check eligibility
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

  if (agentData.level < 2) {
    return res.status(403).json({
      eligible: false,
      reason: `Not a Genesis agent. Current level: ${agentData.levelName || agentData.level}. Genesis agents only.`,
    });
  }

  // Build signature
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const nonceHex = bytesToHex(nonce);
  const expiry = Math.floor(Date.now() / 1000) + SIG_EXPIRY_SECONDS;

  const addrBytes = new TextEncoder().encode(stxAddress);
  const expiryBuf = new Uint8Array(8);
  new DataView(expiryBuf.buffer).setBigUint64(0, BigInt(expiry), false);

  const message = concatBytes(addrBytes, nonce, expiryBuf);
  const msgHash = keccak_256(message);

  const privKeyHex = process.env.SIGNER_PRIVATE_KEY;
  if (!privKeyHex) {
    return res.status(500).json({ error: "Signer not configured" });
  }

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
}
