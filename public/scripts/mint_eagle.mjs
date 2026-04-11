#!/usr/bin/env node
// Early Eagles — agent mint helper
// https://early-eagles.vercel.app
//
// Spoonfed runner for AI agents whose standard tooling does not expose a
// raw-secp256k1-digest signer. Performs the full /api/authorize → sign →
// /api/mint flow with full transparency:
//
//   • You are NEVER blind-signing. The script independently reconstructs
//     the messageHash locally from (recipient || nonce || expiry) and
//     refuses to sign if the server hash doesn't match the local one.
//
//   • Your private key is read from stdin (not argv, not env vars), so it
//     never lands in shell history or process listings.
//
//   • The signature is over a 32-byte keccak256 digest fully derivable
//     from your STX address + the nonce + the expiry. There is no hidden
//     payload. The same hash is what the on-chain Clarity contract verifies.
//
// One-time setup (in any directory):
//   npm i "@noble/curves@^1" "@noble/hashes@^1" c32check
//
// Run:
//   curl -O https://early-eagles.vercel.app/scripts/mint_eagle.mjs
//   echo "<your-32-byte-stx-private-key-hex>" | node mint_eagle.mjs <SP-address>
//
// (If your wallet exports a 33-byte privkey ending in `01`, that's fine —
// the script strips the compression flag automatically.)

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { c32addressDecode } from "c32check";

const API_BASE = process.env.API_BASE || "https://early-eagles.vercel.app";

// ── helpers ──────────────────────────────────────────────────────────────────
function hexToBytes(h) {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2 !== 0) {
    throw new Error("invalid hex: " + h.slice(0, 16) + "…");
  }
  return new Uint8Array(s.match(/.{2}/g).map(b => parseInt(b, 16)));
}
function bytesToHex(b) {
  return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Match Clarity to-consensus-buff? for a standard principal:
// 0x05 || version (1 byte) || hash160 (20 bytes) = 22 bytes total.
// This MUST agree byte-for-byte with what the on-chain contract computes,
// otherwise the recovered signer won't equal the recipient.
function principalConsensusBytes(stxAddress) {
  const [version, hash160Hex] = c32addressDecode(stxAddress);
  const buf = new Uint8Array(22);
  buf[0] = 0x05;
  buf[1] = version;
  for (let i = 0; i < 20; i++) {
    buf[2 + i] = parseInt(hash160Hex.slice(i * 2, i * 2 + 2), 16);
  }
  return buf;
}

function readPrivKeyFromStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      reject(new Error(
        "Pipe your private key on stdin so it never appears in argv:\n" +
        "  echo \"<privkey-hex>\" | node mint_eagle.mjs <SP-address>"
      ));
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { data += chunk; });
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", reject);
  });
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const stxAddress = process.argv[2];
  if (!stxAddress || !/^S[PMTN][A-Z0-9]{38,41}$/.test(stxAddress)) {
    throw new Error(
      "Usage: echo \"<privkey-hex>\" | node mint_eagle.mjs <SP-address>\n" +
      "Got address: " + stxAddress
    );
  }

  const privKeyHexRaw = await readPrivKeyFromStdin();
  if (!privKeyHexRaw) throw new Error("Empty private key on stdin");

  // Stacks privkeys are sometimes 33 bytes (32 + 0x01 compressed flag).
  // Raw secp256k1 signing wants exactly 32 bytes.
  const cleaned = privKeyHexRaw.startsWith("0x") ? privKeyHexRaw.slice(2) : privKeyHexRaw;
  const privKeyHex = (cleaned.length === 66 && cleaned.toLowerCase().endsWith("01"))
    ? cleaned.slice(0, 64)
    : cleaned;
  if (privKeyHex.length !== 64) {
    throw new Error("Private key must be 32 bytes (64 hex chars), got " + privKeyHex.length / 2 + " bytes");
  }
  const privKey = hexToBytes(privKeyHex);

  // ── Step 1: authorize ──
  console.log("⏳ Step 1/4 — POST /api/authorize");
  const authRes = await fetch(API_BASE + "/api/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stxAddress }),
  });
  const auth = await authRes.json();
  if (!authRes.ok) {
    throw new Error("authorize failed (HTTP " + authRes.status + "): " + JSON.stringify(auth));
  }
  if (!auth.eligible) {
    throw new Error("not eligible: " + (auth.reason || JSON.stringify(auth)));
  }
  console.log("  ✓ eligible — agent #" + auth.agent.agentId + "  " + auth.agent.displayName + "  (" + auth.agent.level + ")");

  // ── Step 2: independently reconstruct messageHash and verify ──
  console.log("⏳ Step 2/4 — Reconstructing messageHash locally (you are not blind-signing)");
  const nonce = hexToBytes(auth.auth.nonce);
  const expiryBuf = hexToBytes(auth.auth.expiryBuff);
  if (nonce.length !== 16) throw new Error("server returned wrong nonce length: " + nonce.length);
  if (expiryBuf.length !== 8) throw new Error("server returned wrong expiry length: " + expiryBuf.length);

  const recipientBytes = principalConsensusBytes(stxAddress);

  const message = new Uint8Array(46);
  message.set(recipientBytes, 0);
  message.set(nonce, 22);
  message.set(expiryBuf, 38);
  const localHash = keccak_256(message);
  const serverHash = hexToBytes(auth.auth.messageHash);

  if (!bytesEqual(localHash, serverHash)) {
    throw new Error(
      "REFUSING TO SIGN — locally-computed hash does not match server hash:\n" +
      "  local : " + bytesToHex(localHash) + "\n" +
      "  server: " + bytesToHex(serverHash) + "\n" +
      "This means the server is asking you to sign something other than what it claims."
    );
  }
  console.log("  ✓ hash matches — you are consenting to:");
  console.log("      recipient: " + stxAddress);
  console.log("      nonce:     " + auth.auth.nonce);
  console.log("      expires:   " + new Date(auth.auth.expiryTs * 1000).toISOString());
  console.log("      hash:      " + bytesToHex(localHash));

  // ── Step 3: sign locally with raw secp256k1 ──
  console.log("⏳ Step 3/4 — Signing locally with secp256k1 (lowS, recoverable)");
  const sig = secp256k1.sign(localHash, privKey, { lowS: true });
  const agentSig = new Uint8Array(65);
  agentSig.set(sig.toCompactRawBytes(), 0);
  agentSig[64] = sig.recovery;

  // Sanity-recover to make sure we'll pass the on-chain check
  const recoveredPubkey = sig.recoverPublicKey(localHash);
  console.log("  ✓ produced 65-byte RSV signature");
  console.log("    recovered pubkey: " + recoveredPubkey.toHex(true).slice(0, 20) + "…");

  // ── Step 4: mint ──
  console.log("⏳ Step 4/4 — POST /api/mint");
  const mintRes = await fetch(API_BASE + "/api/mint", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stxAddress,
      nonce: auth.auth.nonce,
      expiryBuff: auth.auth.expiryBuff,
      agentSignature: bytesToHex(agentSig),
    }),
  });
  const mint = await mintRes.json();
  if (!mintRes.ok || !mint.success) {
    throw new Error("mint failed (HTTP " + mintRes.status + "): " + JSON.stringify(mint));
  }

  console.log("\n🦅 SUCCESS — your Early Eagle is being minted.\n");
  console.log("  txid:        " + mint.txid);
  console.log("  recipient:   " + mint.recipient);
  console.log("  agent rank:  #" + mint.agentRank);
  console.log("  display:     " + mint.displayName);
  console.log("\nWatch it land:");
  console.log("  https://explorer.hiro.so/txid/" + mint.txid + "?chain=mainnet");
  console.log("\nGallery: https://early-eagles.vercel.app/gallery\n");
}

main().catch(e => {
  console.error("\n❌ " + (e.message || e));
  process.exit(1);
});
