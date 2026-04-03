/**
 * Deploy test contract to Stacks mainnet
 * Usage: node scripts/deploy-mainnet-test.mjs
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_BASE = '/home/ghislo/.aibtc/node_modules/@aibtc/mcp-server';
const MAINNET_API = 'https://api.hiro.so';
const CONTRACT_NAME = 'early-eagles-test-v1';

const { makeContractDeploy, AnchorMode, PostConditionMode } = await import('@stacks/transactions');
const { STACKS_MAINNET } = await import('@stacks/network');
const { generateWallet } = await import('@stacks/wallet-sdk');
const { decrypt } = await import(`${MCP_BASE}/dist/utils/index.js`);
const { getAddressFromPrivateKey } = await import('@stacks/transactions');

// Get private key
const env = readFileSync('/home/ghislo/.aibtc/.env', 'utf8');
const password = env.match(/AIBTC_WALLET_PASSWORD=(.+)/)[1].trim();
const keystore = JSON.parse(readFileSync(
  '/home/ghislo/.aibtc/wallets/c5cd9b95-98b1-470f-8631-de5010ed126e/keystore.json', 'utf8'
));
const mnemonic = (await decrypt(keystore.encrypted, password)).trim();
const wallet = await generateWallet({ secretKey: mnemonic, password: '' });
const privKey = wallet.accounts[0].stxPrivateKey;
const address = getAddressFromPrivateKey(privKey, 'mainnet');

console.log('Early Eagles TEST - Mainnet Deployment');
console.log('Deployer:', address);
console.log('Contract:', `${address}.${CONTRACT_NAME}`);

// Check balance
const balRes = await fetch(`${MAINNET_API}/v2/accounts/${address}`);
const bal = await balRes.json();
const stxBal = parseInt(bal.balance || '0x0', 16) / 1_000_000;
console.log('Balance:', stxBal, 'STX');

if (stxBal < 1) {
  console.log('Not enough STX for deploy');
  process.exit(1);
}

// Load test contract
const source = readFileSync(join(__dirname, '../contracts/early-eagles-test.clar'), 'utf8');
console.log('Contract size:', source.length, 'bytes');

// Check for non-ASCII
for (let i = 0; i < source.length; i++) {
  if (source.charCodeAt(i) > 127) {
    console.error(`Non-ASCII at position ${i}: ${source.charCodeAt(i)}`);
    process.exit(1);
  }
}
console.log('ASCII check: clean');

// Deploy
console.log('\nDeploying...');
const tx = await makeContractDeploy({
  contractName: CONTRACT_NAME,
  codeBody: source,
  senderKey: privKey,
  network: STACKS_MAINNET,
  anchorMode: AnchorMode.Any,
  postConditionMode: PostConditionMode.Allow,
  fee: 300000n, // 0.3 STX (mainnet needs higher fee)
});

const bytes = Buffer.from(tx.serialize(), 'hex');
const res = await fetch(`${MAINNET_API}/v2/transactions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: bytes,
});
const text = await res.text();

if (!res.ok) {
  console.error('FAILED:', text);
  process.exit(1);
}

const txid = JSON.parse(text);
console.log('TX:', txid);
console.log(`Explorer: https://explorer.hiro.so/txid/${txid}?chain=mainnet`);
console.log(`\nContract will be at: ${address}.${CONTRACT_NAME}`);
console.log('Wait ~10 min for confirmation, then test.');
