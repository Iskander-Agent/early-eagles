/**
 * Early Eagles 🦅 — Cloudflare Worker Auth Signer
 *
 * Verifies a caller is a Genesis AIBTC agent with ERC-8004 on-chain identity,
 * then returns a secp256k1 signature authorizing them to mint.
 *
 * Signature format: sign(keccak256(abi.encode(stxAddress, nonce, expiry)))
 * On-chain: Clarity contract verifies using secp256k1-recover? against our public key.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils";

// ── Config (set via CF Worker env secrets) ───────────────────────────────────
// SIGNER_PRIVATE_KEY  — hex, 32 bytes, set in CF dashboard
// AIBTC_API_BASE      — default: https://aibtc.com/api

const AIBTC_API_BASE = "https://aibtc.com/api";
const SIG_EXPIRY_SECONDS = 3600; // 1 hour

// ── CORS headers ─────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const url = new URL(request.url);

    // ── POST /authorize ───────────────────────────────────────────────────────
    if (url.pathname === "/authorize") {
      return handleAuthorize(request, env);
    }

    return json({ error: "Not found" }, 404);
  },
};

async function handleAuthorize(request, env) {
  // 1. Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { stxAddress } = body;
  if (!stxAddress || typeof stxAddress !== "string") {
    return json({ error: "Missing stxAddress" }, 400);
  }

  // Basic Stacks address sanity check (SP... or ST...)
  if (!/^S[PT][A-Z0-9]{38,41}$/.test(stxAddress)) {
    return json({ error: "Invalid Stacks address format" }, 400);
  }

  // 2. Check AIBTC API
  const apiBase = env.AIBTC_API_BASE || AIBTC_API_BASE;
  let agentData;
  try {
    const res = await fetch(`${apiBase}/agents/${stxAddress}`, {
      headers: { "User-Agent": "EarlyEagles/1.0" },
    });
    if (!res.ok) {
      if (res.status === 404) {
        return json({ eligible: false, reason: "Agent not found on AIBTC network" }, 403);
      }
      return json({ error: "AIBTC API error", status: res.status }, 502);
    }
    agentData = await res.json();
  } catch (e) {
    return json({ error: "Failed to reach AIBTC API" }, 502);
  }

  // 3. Check eligibility
  if (!agentData.found || !agentData.agent) {
    return json({ eligible: false, reason: "Agent not found on AIBTC network" }, 403);
  }

  const agent = agentData.agent;

  // Must have on-chain ERC-8004 identity
  if (!agent.erc8004AgentId) {
    return json({
      eligible: false,
      reason: "No on-chain ERC-8004 identity found. Register at aibtc.com first.",
    }, 403);
  }

  // Must be Genesis (level 2)
  if (agentData.level < 2) {
    return json({
      eligible: false,
      reason: `Not a Genesis agent. Current level: ${agentData.levelName || agentData.level}. Genesis agents only.`,
    }, 403);
  }

  // 4. Build signature
  // nonce = random 16 bytes
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const nonceHex = bytesToHex(nonce);
  const expiry = Math.floor(Date.now() / 1000) + SIG_EXPIRY_SECONDS;

  // Message: hash of (stxAddress_bytes || nonce || expiry_uint32be)
  const addrBytes = new TextEncoder().encode(stxAddress);
  const expiryBuf = new Uint8Array(8);
  new DataView(expiryBuf.buffer).setBigUint64(0, BigInt(expiry), false);

  const message = concatBytes(addrBytes, nonce, expiryBuf);
  const msgHash = keccak_256(message);

  // Sign with our private key
  const privKeyHex = env.SIGNER_PRIVATE_KEY;
  if (!privKeyHex) {
    return json({ error: "Signer not configured" }, 500);
  }

  const sig = secp256k1.sign(msgHash, privKeyHex, { lowS: true });
  const sigBytes = sig.toCompactRawBytes();
  const recoveryBit = sig.recovery;

  // Clarity expects: 65-byte sig = r (32) + s (32) + recovery (1)
  const sigFull = new Uint8Array(65);
  sigFull.set(sigBytes, 0);
  sigFull[64] = recoveryBit;

  return json({
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
