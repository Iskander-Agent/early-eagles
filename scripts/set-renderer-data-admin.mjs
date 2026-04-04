/**
 * set-renderer-data-testnet.mjs
 * Upload the 4 segments (seg1, eagle, seg2, seg3) to the renderer contract.
 * Run after early-eagles-renderer is deployed and confirmed.
 * Sends 4 TXs sequentially (nonce incremented manually).
 * Finally calls lock-data to make everything immutable.
 */
import { readFileSync } from 'fs';

const MCP_BASE = '/home/ghislo/.aibtc/node_modules/@aibtc/mcp-server';
const API = 'https://api.testnet.hiro.so';
const RENDERER_DIR = '/home/ghislo/workspace/nft/early-eagles/renderer';

const { makeContractCall, AnchorMode, PostConditionMode, stringAsciiCV } = await import('@stacks/transactions');
const { STACKS_TESTNET } = await import('@stacks/network');
const { generateWallet, generateNewAccount } = await import('@stacks/wallet-sdk');
const { getAddressFromPrivateKey } = await import('@stacks/transactions');
const { decrypt } = await import(`${MCP_BASE}/dist/utils/index.js`);

const env = readFileSync('/home/ghislo/.aibtc/.env', 'utf8');
const password = env.match(/AIBTC_WALLET_PASSWORD=(.+)/)[1].trim();
const keystore = JSON.parse(readFileSync('/home/ghislo/.aibtc/wallets/c5cd9b95-98b1-470f-8631-de5010ed126e/keystore.json', 'utf8'));
const mnemonic = (await decrypt(keystore.encrypted, password)).trim();
let wallet = await generateWallet({ secretKey: mnemonic, password: '' });
wallet = generateNewAccount(wallet);
const privKey = wallet.accounts[1].stxPrivateKey;
const address = getAddressFromPrivateKey(privKey, 'testnet');

console.log('Setting renderer data as:', address);
console.log('Contract:', `${address}.early-eagles-renderer\n`);

// Check renderer is deployed
const ifaceRes = await fetch(`${API}/v2/contracts/interface/${address}/early-eagles-renderer`);
if (!ifaceRes.ok) {
  console.error('❌ Renderer not deployed yet! Run deploy-renderer-testnet.mjs first.');
  process.exit(1);
}
console.log('✅ Renderer contract found\n');

// Load segments
const seg1  = readFileSync(`${RENDERER_DIR}/seg1.txt`, 'utf8');
const eagle = readFileSync(`${RENDERER_DIR}/eagle.b64`, 'utf8');
const seg2  = readFileSync(`${RENDERER_DIR}/seg2.txt`, 'utf8');
const seg3  = readFileSync(`${RENDERER_DIR}/seg3.txt`, 'utf8');

console.log(`seg1:  ${seg1.length} chars`);
console.log(`eagle: ${eagle.length} chars`);
console.log(`seg2:  ${seg2.length} chars`);
console.log(`seg3:  ${seg3.length} chars`);
console.log();

// Check contract is not already locked
const lockedRes = await fetch(`${API}/v2/contracts/call-read/${address}/early-eagles-renderer/is-locked`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sender: address, arguments: [] }),
});
const lockedData = await lockedRes.json();
if (lockedData.result === '0x03') {
  console.error('❌ Contract is already locked! Data cannot be changed.');
  process.exit(1);
}
console.log('✅ Contract not locked, proceeding\n');

const acctRes = await fetch(`${API}/v2/accounts/${address}`);
const acct = await acctRes.json();
let nonce = acct.nonce;
console.log(`Starting nonce: ${nonce}\n`);

async function broadcast(tx) {
  const bytes = Buffer.from(tx.serialize(), 'hex');
  const res = await fetch(`${API}/v2/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Broadcast failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

async function callFn(fnName, arg, fee = 600000n) {
  console.log(`Calling ${fnName} (${arg.length} chars, nonce ${nonce})...`);
  const tx = await makeContractCall({
    contractAddress: address,
    contractName: 'early-eagles-renderer',
    functionName: fnName,
    functionArgs: [stringAsciiCV(arg)],
    senderKey: privKey,
    network: STACKS_TESTNET,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
    fee,
    nonce: BigInt(nonce),
  });
  const txid = await broadcast(tx);
  console.log(`  ✅ ${txid}`);
  console.log(`  🔗 https://explorer.hiro.so/txid/${txid}?chain=testnet`);
  nonce++;
  await new Promise(r => setTimeout(r, 2000));
  return txid;
}

// Upload all 4 segments
await callFn('set-seg1',  seg1,  400000n);
await callFn('set-eagle', eagle, 800000n);  // largest TX — higher fee
await callFn('set-seg2',  seg2,  200000n);
await callFn('set-seg3',  seg3,  600000n);

// Lock it
console.log(`\nLocking data (nonce ${nonce})...`);
const lockTx = await makeContractCall({
  contractAddress: address,
  contractName: 'early-eagles-renderer',
  functionName: 'lock-data',
  functionArgs: [],
  senderKey: privKey,
  network: STACKS_TESTNET,
  anchorMode: AnchorMode.Any,
  postConditionMode: PostConditionMode.Allow,
  fee: 200000n,
  nonce: BigInt(nonce),
});
const lockTxid = await broadcast(lockTx);
console.log(`  ✅ Locked: ${lockTxid}`);
console.log();
console.log('═══════════════════════════════════════');
console.log('✅ Renderer data fully uploaded and locked!');
console.log('');
console.log('Test get-card-html via:');
console.log('  node scripts/test-renderer-v2.mjs');
