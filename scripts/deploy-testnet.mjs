/**
 * Early Eagles — Stacks Testnet Deployment Script
 * Usage: node scripts/deploy-testnet.mjs
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = join(__dirname, '../contracts');
const MCP_BASE = '/home/ghislo/.aibtc/node_modules/@aibtc/mcp-server';

const DEPLOYER_ADDRESS = 'ST3JR7JXFT7ZM9JKSQPBQG1HPT0D365MA5TX3DS8N';
const TESTNET_API = 'https://api.testnet.hiro.so';

// ── Imports ───────────────────────────────────────────────────────────────────
const { makeContractDeploy, AnchorMode, PostConditionMode } = await import('@stacks/transactions');
const { STACKS_TESTNET } = await import('@stacks/network');
const { generateWallet } = await import('@stacks/wallet-sdk');
const { decrypt } = await import(`${MCP_BASE}/dist/utils/index.js`);

// ── Get private key ───────────────────────────────────────────────────────────
async function getPrivKey() {
  const env = readFileSync('/home/ghislo/.aibtc/.env', 'utf8');
  const password = env.match(/AIBTC_WALLET_PASSWORD=(.+)/)[1].trim();
  const keystore = JSON.parse(readFileSync(
    '/home/ghislo/.aibtc/wallets/c5cd9b95-98b1-470f-8631-de5010ed126e/keystore.json', 'utf8'
  ));
  const mnemonic = (await decrypt(keystore.encrypted, password)).trim();
  const wallet = await generateWallet({ secretKey: mnemonic, password: '' });
  return wallet.accounts[0].stxPrivateKey;
}

// ── Broadcast (serialize() returns hex string in @stacks/transactions v7) ────
async function broadcast(tx) {
  const bytes = Buffer.from(tx.serialize(), 'hex');
  const res = await fetch(`${TESTNET_API}/v2/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Broadcast failed (${res.status}): ${text}`);
  return JSON.parse(text); // txid string
}

// ── Deploy ────────────────────────────────────────────────────────────────────
async function deployContract(name, source, privKey) {
  console.log(`\n📄 Deploying ${name}...`);
  const tx = await makeContractDeploy({
    contractName: name,
    codeBody: source,
    senderKey: privKey,
    network: STACKS_TESTNET,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
    fee: 200000n,
  });
  const txid = await broadcast(tx);
  console.log(`  ✅ TX: ${txid}`);
  console.log(`  🔍 https://explorer.hiro.so/txid/${txid}?chain=testnet`);
  return txid;
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log('🦅 Early Eagles — Testnet Deployment\n');

const balRes = await fetch(`${TESTNET_API}/v2/accounts/${DEPLOYER_ADDRESS}`);
const bal = await balRes.json();
const stxBal = parseInt(bal.balance || '0x0') / 1_000_000;
console.log(`Testnet balance: ${stxBal} STX`);
if (stxBal < 0.5) { console.log('⚠️  Need faucet STX'); process.exit(1); }

console.log('Decrypting wallet...');
const privKey = await getPrivKey();
console.log('✅ Key ready');

const rendererSrc = readFileSync(join(CONTRACTS_DIR, 'early-eagles-renderer.clar'), 'utf8');
const nftSrc = readFileSync(join(CONTRACTS_DIR, 'early-eagles.clar'), 'utf8');

await deployContract('early-eagles-renderer', rendererSrc, privKey);

console.log('\n⏳ Waiting 20s...');
await new Promise(r => setTimeout(r, 20000));

await deployContract('early-eagles', nftSrc, privKey);

console.log('\n✅ Deployment complete!');
console.log(`Renderer: ${DEPLOYER_ADDRESS}.early-eagles-renderer`);
console.log(`NFT:      ${DEPLOYER_ADDRESS}.early-eagles`);
