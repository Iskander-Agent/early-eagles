/**
 * Update seg1 in the deployed renderer contract.
 * Uses account[1] (admin) - same as mint-reserved.mjs
 */
import { readFileSync } from 'fs';
const MCP_BASE = '/home/ghislo/.aibtc/node_modules/@aibtc/mcp-server';
const API = 'https://api.testnet.hiro.so';
const ADMIN = 'ST3HR09GX5YFDPP7271GG1Y9P4ZZ70DRE7H2AYYEM';
const RENDERER = 'early-eagles-renderer';

const { makeContractCall, AnchorMode, PostConditionMode, stringAsciiCV, getAddressFromPrivateKey } = await import('@stacks/transactions');
const { STACKS_TESTNET } = await import('@stacks/network');
const { generateWallet, generateNewAccount } = await import('@stacks/wallet-sdk');
const { decrypt } = await import(`${MCP_BASE}/dist/utils/index.js`);

const env = readFileSync('/home/ghislo/.aibtc/.env', 'utf8');
const password = env.match(/AIBTC_WALLET_PASSWORD=(.+)/)[1].trim();
const keystore = JSON.parse(readFileSync('/home/ghislo/.aibtc/wallets/c5cd9b95-98b1-470f-8631-de5010ed126e/keystore.json', 'utf8'));
const mnemonic = (await decrypt(keystore.encrypted, password)).trim();
let wallet = await generateWallet({ secretKey: mnemonic, password: '' });
wallet = generateNewAccount(wallet);
const privKey = wallet.accounts[1].stxPrivateKey;
const address = getAddressFromPrivateKey(privKey, 'testnet');
console.log('Admin address:', address);
if (address !== ADMIN) throw new Error(`Expected ${ADMIN}, got ${address}`);

const acctRes = await fetch(`${API}/v2/accounts/${address}`);
const acct = await acctRes.json();
const nonce = acct.nonce;
console.log(`Balance: ${parseInt(acct.balance,16)/1e6} STX | Nonce: ${nonce}`);

// Read new seg1
const newSeg1 = readFileSync('/tmp/new-seg1-test.html','utf8').trimEnd();
console.log('New seg1 length:', newSeg1.length, 'chars');

// Check if locked
const lockRes = await fetch(`${API}/v2/contracts/call-read/${ADMIN}/${RENDERER}/is-locked`, {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ sender: ADMIN, arguments: [] })
}).then(r=>r.json());
console.log('Renderer locked?', lockRes.result);

const tx = await makeContractCall({
  contractAddress: ADMIN, contractName: RENDERER,
  functionName: 'set-seg1',
  functionArgs: [stringAsciiCV(newSeg1)],
  senderKey: privKey, network: STACKS_TESTNET,
  anchorMode: AnchorMode.Any, postConditionMode: PostConditionMode.Allow,
  fee: 300000n, nonce: BigInt(nonce),
});

const bytes = Buffer.from(tx.serialize(), 'hex');
const res = await fetch(`${API}/v2/transactions`, {
  method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
});
const text = await res.text();
if (!res.ok) throw new Error(`Failed (${res.status}): ${text}`);
const txid = JSON.parse(text);
console.log('\n✅ set-seg1 TX:', txid);
console.log('🔗 https://explorer.hiro.so/txid/' + txid + '?chain=testnet');
console.log('\nWait ~30s then refresh the gallery!');
