/**
 * mainnet-deploy-task-escrow.mjs
 *
 * Deploys eagle-task-escrow-v1.clar to Stacks MAINNET.
 * Simple STX escrow for the Eagle Task Exchange marketplace.
 *
 * Prerequisites:
 *   source ~/.early-eagles-keys/deploy-wallet.enc.sh
 *
 * Usage:
 *   source ~/.early-eagles-keys/deploy-wallet.enc.sh && node scripts/mainnet-deploy-task-escrow.mjs
 */
import { readFileSync } from "fs";

const MAINNET_API       = "https://api.hiro.so";
const CONTRACT_PATH     = "/home/ghislo/workspace/nft/early-eagles/contracts/eagle-task-escrow-v1.clar";
const EXPECTED_ADDRESS  = "SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2";
const CONTRACT_NAME     = "eagle-task-escrow-v1";

const { makeContractDeploy, AnchorMode, PostConditionMode, getAddressFromPrivateKey, ClarityVersion } =
  await import("@stacks/transactions");
const { STACKS_MAINNET } = await import("@stacks/network");
const { generateWallet }  = await import("@stacks/wallet-sdk");

const mnemonic = process.env.EAGLES_MNEMONIC;
if (!mnemonic) {
  console.error("EAGLES_MNEMONIC not set. Run: source ~/.early-eagles-keys/deploy-wallet.enc.sh");
  process.exit(1);
}

const wallet  = await generateWallet({ secretKey: mnemonic, password: "" });
const privKey = wallet.accounts[0].stxPrivateKey;
const address = getAddressFromPrivateKey(privKey, "mainnet");

if (address !== EXPECTED_ADDRESS) {
  console.error("FATAL: derived address " + address + " != expected " + EXPECTED_ADDRESS);
  process.exit(1);
}

console.log("=== mainnet-deploy-task-escrow ===");
console.log("Network:  MAINNET");
console.log("Wallet:   " + address);

const source = readFileSync(CONTRACT_PATH, "utf8");
console.log("Source:   eagle-task-escrow-v1.clar (" + source.length + " chars)");

// Sanity: no testnet addresses or stubs
if (source.includes("ST35A2J9") || source.includes("testnet") || source.includes("-stub")) {
  console.error("FATAL: contract contains testnet references — wrong file");
  process.exit(1);
}
console.log("Pre-flight: clean (no testnet references)");

// Balance + nonce
const acctRes = await fetch(MAINNET_API + "/v2/accounts/" + address + "?proof=0");
const acct    = await acctRes.json();
const balance = parseInt(acct.balance, 16) / 1e6;
const nonce   = acct.nonce;
console.log("Balance:  " + balance + " STX");
console.log("Nonce:    " + nonce);

if (balance < 1) {
  console.error("FATAL: insufficient balance (" + balance + " STX). Need at least 1 STX.");
  process.exit(1);
}

// Already deployed?
const checkRes = await fetch(MAINNET_API + "/v2/contracts/interface/" + address + "/" + CONTRACT_NAME);
if (checkRes.ok) {
  console.log("Already deployed: " + address + "." + CONTRACT_NAME);
  console.log("Explorer: https://explorer.hiro.so/contract/" + address + "." + CONTRACT_NAME + "?chain=mainnet");
  process.exit(0);
}

const fee = 400000n; // 0.4 STX
console.log("Fee:      " + (Number(fee) / 1e6) + " STX");
console.log("");
console.log("Building deploy tx...");

const tx = await makeContractDeploy({
  contractName:      CONTRACT_NAME,
  codeBody:          source,
  senderKey:         privKey,
  network:           STACKS_MAINNET,
  anchorMode:        AnchorMode.Any,
  postConditionMode: PostConditionMode.Allow,
  clarityVersion:    ClarityVersion.Clarity3,
  fee,
  nonce:             BigInt(nonce),
});

console.log("Broadcasting...");
const bytes = Buffer.from(tx.serialize(), "hex");
const res   = await fetch(MAINNET_API + "/v2/transactions", {
  method:  "POST",
  headers: { "Content-Type": "application/octet-stream" },
  body:    bytes,
});
const text = await res.text();

if (!res.ok) {
  console.error("FATAL: Broadcast failed (" + res.status + "): " + text);
  process.exit(1);
}

const txid = JSON.parse(text);
console.log("");
console.log("=== Broadcast OK ===");
console.log("txid:     " + txid);
console.log("explorer: https://explorer.hiro.so/txid/0x" + txid + "?chain=mainnet");
console.log("contract: " + address + "." + CONTRACT_NAME);
