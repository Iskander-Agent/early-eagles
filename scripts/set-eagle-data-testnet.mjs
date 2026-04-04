/**
 * set-eagle-data-testnet.mjs
 *
 * One-time call: uploads the base64 eagle PNG to the renderer contract on testnet.
 * Must be called after deploy-testnet-phase1.mjs succeeds.
 * Wait for the renderer deploy TX to confirm before running this.
 */

import { readFileSync } from 'fs';

const MCP_BASE = '/home/ghislo/.aibtc/node_modules/@aibtc/mcp-server';
const TESTNET_API = 'https://api.testnet.hiro.so';
const EAGLE_PNG = '/home/ghislo/.openclaw/media/inbound/eagle-transparent-420---6f6dd4af-f409-4a9d-9f08-fde9e90c8a03.png';

const { makeContractCall, AnchorMode, PostConditionMode, stringAsciiCV } = await import('@stacks/transactions');
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

console.log('Calling set-eagle-data as:', address);

// Convert eagle PNG to base64
const pngBytes = readFileSync(EAGLE_PNG);
const b64 = pngBytes.toString('base64');
console.log(`Eagle PNG: ${pngBytes.length} bytes → ${b64.length} chars base64`);

// Clarity string-ascii max is 65536 chars (we use this for pure-ASCII base64)
if (b64.length > 65536) {
  console.error(`❌ Base64 too large! ${b64.length} > 65536`);
  process.exit(1);
}
console.log(`✅ Size OK: ${b64.length}/65536 chars`);

// Get current nonce
const acctRes = await fetch(`${TESTNET_API}/v2/accounts/${address}`);
const acct = await acctRes.json();
const nonce = acct.nonce;
console.log(`Nonce: ${nonce}`);

async function broadcast(tx) {
  const bytes = tx.serialize();
  const res = await fetch(`${TESTNET_API}/v2/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Broadcast failed (${res.status}): ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

console.log('\nSending set-eagle-data transaction...');
const tx = await makeContractCall({
  contractAddress: address,
  contractName: 'early-eagles-renderer',
  functionName: 'set-eagle-data',
  functionArgs: [stringAsciiCV(b64)],
  senderKey: privKey,
  network: STACKS_TESTNET,
  anchorMode: AnchorMode.Any,
  postConditionMode: PostConditionMode.Allow,
  fee: 500000n,  // 0.5 STX — large TX needs higher fee
  nonce: BigInt(nonce),
});

const txid = await broadcast(tx);
console.log(`\n✅ TX submitted: ${txid}`);
console.log(`🔗 https://explorer.hiro.so/txid/${txid}?chain=testnet`);
console.log('\nWait for confirmation, then run: node scripts/test-phase1.mjs');
