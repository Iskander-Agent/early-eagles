/**
 * deploy-renderer-testnet.mjs
 * Deploy early-eagles-renderer-v3 contract to testnet.
 * Run once. Then run set-renderer-data-v2-testnet.mjs to upload the segments.
 */
import { readFileSync } from 'fs';

const MCP_BASE = '/home/ghislo/.aibtc/node_modules/@aibtc/mcp-server';
const API = 'https://api.testnet.hiro.so';

const { makeContractDeploy, AnchorMode, PostConditionMode } = await import('@stacks/transactions');
const { STACKS_TESTNET } = await import('@stacks/network');
const { generateWallet, getAddressFromPrivateKey } = await import('@stacks/wallet-sdk');
const { getAddressFromPrivateKey: getAddr } = await import('@stacks/transactions');
const { decrypt } = await import(`${MCP_BASE}/dist/utils/index.js`);

const env = readFileSync('/home/ghislo/.aibtc/.env', 'utf8');
const password = env.match(/AIBTC_WALLET_PASSWORD=(.+)/)[1].trim();
const keystore = JSON.parse(readFileSync('/home/ghislo/.aibtc/wallets/c5cd9b95-98b1-470f-8631-de5010ed126e/keystore.json', 'utf8'));
const mnemonic = (await decrypt(keystore.encrypted, password)).trim();
const wallet = await generateWallet({ secretKey: mnemonic, password: '' });
const privKey = wallet.accounts[0].stxPrivateKey;
const address = getAddr(privKey, 'testnet');

console.log('Deploying from:', address);

const acctRes = await fetch(`${API}/v2/accounts/${address}`);
const acct = await acctRes.json();
const stx = parseInt(acct.balance, 16) / 1e6;
console.log(`Balance: ${stx} STX | Nonce: ${acct.nonce}\n`);

const source = readFileSync('/home/ghislo/workspace/nft/early-eagles/contracts/early-eagles-renderer-v3.clar', 'utf8');
console.log(`Contract: ${source.length} chars`);

const tx = await makeContractDeploy({
  contractName: 'early-eagles-renderer-v3',
  codeBody: source,
  senderKey: privKey,
  network: STACKS_TESTNET,
  anchorMode: AnchorMode.Any,
  postConditionMode: PostConditionMode.Allow,
  fee: 200000n,
  nonce: BigInt(acct.nonce),
});

const bytes = Buffer.from(tx.serialize(), 'hex');
const res = await fetch(`${API}/v2/transactions`, {
  method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
});
const text = await res.text();
if (!res.ok) throw new Error(`Deploy failed (${res.status}): ${text}`);
const txid = JSON.parse(text);
console.log(`\n✅ TX: ${txid}`);
console.log(`🔗 https://explorer.hiro.so/txid/${txid}?chain=testnet`);
console.log('\nWait ~2 min for confirm, then run:');
console.log('  node scripts/set-renderer-data-v2-testnet.mjs');
