/**
 * Early Eagles — Phase 1 Testnet Deploy
 *
 * Deploys in order:
 *   1. commission-trait
 *   2. commission-stx
 *   3. commission-sbtc-testnet
 *   4. early-eagles-renderer
 *   5. early-eagles-v2-testnet
 *
 * After deploy, run set-eagle-data separately (large payload).
 *
 * Testnet addresses used:
 *   nft-trait:       ST1NXBK3K5YYMD6FD41MVNP3JS1GABZ8TRVX023PT
 *   sip-010-trait:   ST1NXBK3K5YYMD6FD41MVNP3JS1GABZ8TRVX023PT
 *   sbtc-token:      STV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RJ5XDY2 (has faucet)
 */

import { readFileSync } from 'fs';

const MCP_BASE = '/home/ghislo/.aibtc/node_modules/@aibtc/mcp-server';
const TESTNET_API = 'https://api.testnet.hiro.so';

const { makeContractDeploy, AnchorMode, PostConditionMode } = await import('@stacks/transactions');
const { STACKS_TESTNET } = await import('@stacks/network');
const { generateWallet } = await import('@stacks/wallet-sdk');
const { getAddressFromPrivateKey } = await import('@stacks/transactions');
const { decrypt } = await import(`${MCP_BASE}/dist/utils/index.js`);

// Load wallet
const env = readFileSync('/home/ghislo/.aibtc/.env', 'utf8');
const password = env.match(/AIBTC_WALLET_PASSWORD=(.+)/)[1].trim();
const keystore = JSON.parse(readFileSync('/home/ghislo/.aibtc/wallets/c5cd9b95-98b1-470f-8631-de5010ed126e/keystore.json', 'utf8'));
const mnemonic = (await decrypt(keystore.encrypted, password)).trim();
const wallet = await generateWallet({ secretKey: mnemonic, password: '' });
const privKey = wallet.accounts[0].stxPrivateKey;
const address = getAddressFromPrivateKey(privKey, 'testnet');

console.log('Deploying from:', address);
console.log('Network: Stacks Testnet\n');

// Check testnet balance
const balRes = await fetch(`${TESTNET_API}/v2/accounts/${address}`);
const balData = await balRes.json();
const stxBalance = parseInt(balData.balance, 16) / 1_000_000;
console.log(`STX balance: ${stxBalance} STX`);
if (stxBalance < 1) {
  console.error('⚠️  Low testnet STX! Get some from the faucet:');
  console.error(`   https://explorer.hiro.so/sandbox/faucet?chain=testnet`);
  process.exit(1);
}
console.log();

const CONTRACTS_DIR = '/home/ghislo/workspace/nft/early-eagles/contracts';

const deployQueue = [
  { name: 'commission-trait',        file: 'commission-trait.clar' },
  { name: 'commission-stx',          file: 'commission-stx.clar' },
  { name: 'commission-sbtc',         file: 'commission-sbtc-testnet.clar' },
  { name: 'early-eagles-renderer',   file: 'early-eagles-renderer.clar' },
  { name: 'early-eagles-v2',         file: 'early-eagles-v2-testnet.clar' },
];

async function broadcast(tx) {
  const bytes = Buffer.from(tx.serialize(), 'hex');
  const res = await fetch(`${TESTNET_API}/v2/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Broadcast failed (${res.status}): ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function getNonce() {
  const res = await fetch(`${TESTNET_API}/v2/accounts/${address}`);
  const data = await res.json();
  return data.nonce;
}

const deployed = {};
let nonce = await getNonce();
console.log(`Starting nonce: ${nonce}\n`);

for (const { name, file } of deployQueue) {
  const source = readFileSync(`${CONTRACTS_DIR}/${file}`, 'utf8');
  console.log(`Deploying ${name} (${file}, ${source.length} chars)...`);

  try {
    const tx = await makeContractDeploy({
      contractName: name,
      codeBody: source,
      senderKey: privKey,
      network: STACKS_TESTNET,
      anchorMode: AnchorMode.Any,
      postConditionMode: PostConditionMode.Allow,
      fee: 200000n,  // 0.2 STX per deploy — generous for testnet
      nonce: BigInt(nonce),
    });

    const txid = await broadcast(tx);
    console.log(`  ✅ TX: ${txid}`);
    console.log(`  🔗 https://explorer.hiro.so/txid/${txid}?chain=testnet`);
    deployed[name] = { txid, address };
    nonce++;

    // Wait a bit between deploys to avoid nonce issues
    console.log('  Waiting 3s...');
    await new Promise(r => setTimeout(r, 3000));
  } catch (err) {
    console.error(`  ❌ FAILED: ${err.message}`);
    process.exit(1);
  }
  console.log();
}

console.log('═══════════════════════════════════════════════');
console.log('✅ All 5 contracts deployed to testnet!');
console.log('');
console.log('Deployed contracts:');
for (const [name, info] of Object.entries(deployed)) {
  console.log(`  ${address}.${name}`);
  console.log(`    TX: ${info.txid}`);
}
console.log('');
console.log('⚠️  NEXT STEP: call set-eagle-data on the renderer');
console.log('   Run: node scripts/set-eagle-data-testnet.mjs');
console.log('');
console.log('After set-eagle-data, run the test suite:');
console.log('   node scripts/test-phase1.mjs');
