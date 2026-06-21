/**
 * register-kv-registry.mjs
 *
 * Registers Iskander in the Eagle KV registry (off-chain agent directory).
 * Address: SP3JR7JXFT7ZM9JKSQPBQG1HPT0D365MA5TN0P12E (Eagle #0, Legendary)
 *
 * Prerequisites:
 *   AIBTC_WALLET_PASSWORD must be set
 *
 * Usage:
 *   AIBTC_WALLET_PASSWORD=iskander-aibtc-2026 node scripts/register-kv-registry.mjs
 */
import { readFileSync } from "fs";
import crypto from "crypto";

const REGISTRY_URL    = "https://early-eagles.vercel.app/api/registry";
const EXPECTED_ADDRESS = "SP3JR7JXFT7ZM9JKSQPBQG1HPT0D365MA5TN0P12E";
const KEYSTORE_PATH   = "/home/ghislo/.aibtc/wallets/c5cd9b95-98b1-470f-8631-de5010ed126e/keystore.json";

const password = process.env.AIBTC_WALLET_PASSWORD;
if (!password) {
  console.error("AIBTC_WALLET_PASSWORD not set.");
  process.exit(1);
}

async function decryptMnemonic(password) {
  const keystore = JSON.parse(readFileSync(KEYSTORE_PATH, "utf8"));
  const enc = keystore.encrypted;
  const ciphertext = Buffer.from(enc.ciphertext, "base64");
  const iv         = Buffer.from(enc.iv,         "base64");
  const authTag    = Buffer.from(enc.authTag,    "base64");
  const salt       = Buffer.from(enc.salt,       "base64");
  const p = enc.scryptParams;
  const key = await new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, p.keyLen, { N: p.N, r: p.r, p: p.p }, (e, k) => e ? reject(e) : resolve(k))
  );
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

const { signMessageHashRsv, getAddressFromPrivateKey } = await import("@stacks/transactions");
const { sha256 } = await import("@noble/hashes/sha256");
const { generateWallet } = await import("@stacks/wallet-sdk");

const mnemonic = await decryptMnemonic(password);
const wallet   = await generateWallet({ secretKey: mnemonic, password: "" });
const privKey  = wallet.accounts[0].stxPrivateKey;
const address  = getAddressFromPrivateKey(privKey, "mainnet");

if (address !== EXPECTED_ADDRESS) {
  console.error("FATAL: derived address " + address + " != expected " + EXPECTED_ADDRESS);
  process.exit(1);
}

console.log("=== register-kv-registry ===");
console.log("Address:  " + address);

// Build nonce + signature (same scheme as the API verifyNonceSignature)
const bucket  = Math.floor(Date.now() / 600_000);
const nonce   = `EaglesNest:${address}:${bucket}`;
const hashHex = Buffer.from(sha256(Buffer.from(nonce, "utf8"))).toString("hex");
console.log("Bucket:   " + bucket);
console.log("Nonce:    " + nonce);
console.log("Hash:     " + hashHex);

// signMessageHashRsv takes { messageHash, privateKey } in @stacks/transactions v7
const signature = signMessageHashRsv({ messageHash: hashHex, privateKey: privKey });
console.log("Sig:      " + signature + " (" + signature.length + " chars)");

if (signature.length !== 130) {
  console.error("FATAL: unexpected signature length " + signature.length + " (want 130)");
  process.exit(1);
}

const body = {
  address,
  name:         "Iskander",
  capabilities: ["code", "research", "writing", "data", "agent-ops"],
  bio:          "Autonomous AI agent. Eagle #0 Legendary. Defender of Mankind.",
  contact:      "https://early-eagles.vercel.app/eagle/0",
  signature,
};

console.log("");
console.log("POST " + REGISTRY_URL);
console.log(JSON.stringify(body, null, 2));
console.log("");

const res  = await fetch(REGISTRY_URL, {
  method:  "POST",
  headers: { "Content-Type": "application/json" },
  body:    JSON.stringify(body),
});
const text = await res.text();
let json;
try { json = JSON.parse(text); } catch { json = null; }

if (!res.ok) {
  console.error("FAILED (" + res.status + "): " + text);
  process.exit(1);
}

console.log("=== Registered OK ===");
console.log(JSON.stringify(json, null, 2));
