/**
 * Deploy early-eagles-renderer-v5 and immediately set all segments.
 * Uses the new seg1 design (contain eagle, 44px rank, old beautiful layout).
 */
import { readFileSync } from 'fs';
const MCP_BASE = '/home/ghislo/.aibtc/node_modules/@aibtc/mcp-server';
const API = 'https://api.testnet.hiro.so';
const ADMIN = 'ST3HR09GX5YFDPP7271GG1Y9P4ZZ70DRE7H2AYYEM';
const NEW_RENDERER = 'early-eagles-renderer-v5';
const OLD_RENDERER = 'early-eagles-renderer';

const { makeContractCall, makeContractDeploy, AnchorMode, PostConditionMode,
        stringAsciiCV, getAddressFromPrivateKey } = await import('@stacks/transactions');
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
console.log('Admin:', address);
if (address !== ADMIN) throw new Error(`Wrong address: ${address}`);

const acctRes = await fetch(`${API}/v2/accounts/${address}`);
const acct = await acctRes.json();
let nonce = acct.nonce;
console.log(`Balance: ${parseInt(acct.balance,16)/1e6} STX | Nonce: ${nonce}\n`);

async function broadcast(tx) {
  const bytes = Buffer.from(tx.serialize(), 'hex');
  const res = await fetch(`${API}/v2/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

async function waitConfirm(txid, label) {
  console.log(`  Waiting for ${label} (${txid.slice(0,12)}...)...`);
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const tx = await fetch(`${API}/extended/v1/tx/${txid}`).then(r=>r.json());
    if (tx.tx_status === 'success') { console.log(`  ✅ ${label} confirmed`); return; }
    if (tx.tx_status === 'abort_by_response' || tx.tx_status === 'abort_by_post_condition') {
      throw new Error(`TX aborted: ${JSON.stringify(tx.tx_result)}`);
    }
    process.stdout.write('.');
  }
  throw new Error('Timeout waiting for confirmation');
}

// 1. Deploy new renderer contract
console.log('1. Deploying', NEW_RENDERER, '...');
const clarityCode = readFileSync('/home/ghislo/workspace/nft/early-eagles/contracts/early-eagles-renderer-v5.clar', 'utf8');
const deployTx = await makeContractDeploy({
  contractName: NEW_RENDERER,
  codeBody: clarityCode,
  senderKey: privKey, network: STACKS_TESTNET,
  anchorMode: AnchorMode.Any, postConditionMode: PostConditionMode.Allow,
  fee: 500000n, nonce: BigInt(nonce),
});
const deployTxid = await broadcast(deployTx);
console.log('  TX:', deployTxid);
nonce++;
await waitConfirm(deployTxid, 'deploy');

// Get old segments to copy
console.log('\n2. Fetching old segments...');
async function rRead(contract, fn) {
  const url = `${API}/v2/contracts/call-read/${ADMIN}/${contract}/${fn}`;
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ sender: ADMIN, arguments: [] }) });
  const d = await r.json();
  let hex = d.result.replace('0x','');
  if (hex.startsWith('07')) hex = hex.slice(2);
  if (hex.startsWith('0d') || hex.startsWith('09')) hex = hex.slice(2);
  const len = parseInt(hex.slice(0,8),16);
  const strHex = hex.slice(8, 8+len*2);
  return (strHex.match(/.{2}/g)||[]).map(b=>parseInt(b,16)).reduce((a,c)=>a+String.fromCharCode(c),'');
}

const eagle = await rRead(OLD_RENDERER, 'get-eagle');
const seg2  = await rRead(OLD_RENDERER, 'get-seg2');
const seg3  = await rRead(OLD_RENDERER, 'get-seg3');
const newSeg1 = readFileSync('/tmp/new-seg1-test.html','utf8').trimEnd();
console.log(`  seg1: ${newSeg1.length} chars (NEW DESIGN)`);
console.log(`  eagle: ${eagle.length} chars`);
console.log(`  seg2: ${seg2.length} chars`);
console.log(`  seg3: ${seg3.length} chars`);

// 3. Set all segments
async function setData(fn, data, label) {
  console.log(`\n3. Setting ${label} (${data.length} chars)...`);
  const tx = await makeContractCall({
    contractAddress: ADMIN, contractName: NEW_RENDERER,
    functionName: fn,
    functionArgs: [stringAsciiCV(data)],
    senderKey: privKey, network: STACKS_TESTNET,
    anchorMode: AnchorMode.Any, postConditionMode: PostConditionMode.Allow,
    fee: 400000n, nonce: BigInt(nonce),
  });
  const txid = await broadcast(tx);
  console.log('  TX:', txid);
  nonce++;
  await waitConfirm(txid, label);
}

await setData('set-seg1',  newSeg1, 'seg1 (new design)');
await setData('set-eagle', eagle,   'eagle (base64)');
await setData('set-seg2',  seg2,    'seg2');
await setData('set-seg3',  seg3,    'seg3');

console.log('\n✅ All segments set!');
console.log(`New renderer: ${ADMIN}.${NEW_RENDERER}`);
console.log('Now update index.html RENDERER constant and push.');
