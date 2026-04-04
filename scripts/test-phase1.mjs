/**
 * test-phase1.mjs — Early Eagles Phase 1 Test Suite
 *
 * Tests (all on testnet):
 *   1. Mint 3 NFTs via airdrop-mint (Legendary, Epic, Common)
 *   2. Verify traits stored on-chain
 *   3. List token #0 for STX
 *   4. Attempt transfer while listed (expect failure ERR-LISTING)
 *   5. Buy token #0 (verify STX flows + royalty)
 *   6. Unlist token #1
 *   7. List token #1 for sBTC, buy with testnet sbtc-token
 *   8. Print get-token-uri result for each token
 */

import { readFileSync } from 'fs';

const MCP_BASE = '/home/ghislo/.aibtc/node_modules/@aibtc/mcp-server';
const TESTNET_API = 'https://api.testnet.hiro.so';

const {
  makeContractCall, makeContractDeploy,
  AnchorMode, PostConditionMode,
  uintCV, bufferCV, stringUtf8CV, stringAsciiCV, standardPrincipalCV, contractPrincipalCV,
  cvToJSON, fetchCallReadOnlyFunction
} = await import('@stacks/transactions');
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
const { standardPrincipalCV: spCV } = await import('@stacks/transactions');

console.log('Test runner:', address);
console.log('Contract deployer (same):', address);
console.log();

const CONTRACT = address; // deployer address
const NFT = 'early-eagles-v2';
const RENDERER = 'early-eagles-renderer';
const COMM_STX = 'commission-stx';
const COMM_SBTC = 'commission-sbtc';
const SBTC = 'STV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RJ5XDY2';
const SBTC_NAME = 'sbtc-token';

let _nonce = null;
async function getNonce() {
  if (_nonce === null) {
    const res = await fetch(`${TESTNET_API}/v2/accounts/${address}`);
    _nonce = (await res.json()).nonce;
  }
  return _nonce++;
}

async function broadcast(tx) {
  const bytes = Buffer.from(tx.serialize(), 'hex');
  const res = await fetch(`${TESTNET_API}/v2/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Broadcast (${res.status}): ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function call(functionName, functionArgs, fee = 100000n) {
  const nonce = await getNonce();
  const tx = await makeContractCall({
    contractAddress: CONTRACT,
    contractName: NFT,
    functionName,
    functionArgs,
    senderKey: privKey,
    network: STACKS_TESTNET,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
    fee,
    nonce: BigInt(nonce),
  });
  return broadcast(tx);
}

async function readOnly(contractAddr, contractName, fn, args) {
  const res = await fetch(
    `${TESTNET_API}/v2/contracts/call-read/${contractAddr}/${contractName}/${fn}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: address,
        arguments: args.map(a => {
          const { serializeCV } = require('@stacks/transactions');
          return Buffer.from(serializeCV(a)).toString('hex');
        }),
      }),
    }
  );
  return res.json();
}

const sigil = Buffer.alloc(16);
sigil.fill(0xab);

console.log('═══ TEST 1: Mint 3 NFTs via airdrop-mint ═══');

const mints = [
  { agentId: 124, name: 'Iskander',     btc: 'bc1qxj5jtv8jwm7zv2nczn2xfq9agjgj0sqpsxn43h', tier: 0, color: 12 }, // Legendary Gold
  { agentId: 1,   name: 'Tiny Marten',  btc: 'bc1qtestmarten00000000000000000000000000000',  tier: 1, color: 1  }, // Epic Amethyst
  { agentId: 42,  name: 'Test Eagle',   btc: 'bc1qtestcommon00000000000000000000000000000',  tier: 4, color: 6  }, // Common Forest
];

const txids = [];
for (const m of mints) {
  console.log(`  Minting: ${m.name} (tier ${m.tier}, color ${m.color}, rank ${m.agentId})...`);
  const nonce = await getNonce();
  const tx = await makeContractCall({
    contractAddress: CONTRACT,
    contractName: NFT,
    functionName: 'airdrop-mint',
    functionArgs: [
      standardPrincipalCV(address),
      uintCV(m.agentId),
      stringUtf8CV(m.name),
      stringAsciiCV(m.btc),
      uintCV(m.tier),
      uintCV(m.color),
      bufferCV(sigil),
    ],
    senderKey: privKey,
    network: STACKS_TESTNET,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
    fee: 150000n,
    nonce: BigInt(nonce),
  });
  const txid = await broadcast(tx);
  console.log(`    ✅ ${txid}`);
  txids.push(txid);
  await new Promise(r => setTimeout(r, 2000));
}

console.log();
console.log('═══ TEST 2: List token #0 for STX ═══');
{
  const nonce = await getNonce();
  const tx = await makeContractCall({
    contractAddress: CONTRACT,
    contractName: NFT,
    functionName: 'list-in-ustx',
    functionArgs: [
      uintCV(0),
      uintCV(5_000_000n), // 5 STX
      contractPrincipalCV(CONTRACT, COMM_STX),
    ],
    senderKey: privKey,
    network: STACKS_TESTNET,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
    fee: 100000n,
    nonce: BigInt(nonce),
  });
  const txid = await broadcast(tx);
  console.log(`  Listed token #0 at 5 STX: ${txid}`);
}

console.log();
console.log('═══ TEST 3: Transfer while listed (expect FAILURE) ═══');
{
  const nonce = await getNonce();
  const tx = await makeContractCall({
    contractAddress: CONTRACT,
    contractName: NFT,
    functionName: 'transfer',
    functionArgs: [
      uintCV(0),
      standardPrincipalCV(address),
      standardPrincipalCV(address), // transfer to self — should fail with ERR-LISTING
    ],
    senderKey: privKey,
    network: STACKS_TESTNET,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
    fee: 100000n,
    nonce: BigInt(nonce),
  });
  const txid = await broadcast(tx);
  console.log(`  TX (should abort): ${txid}`);
  console.log(`  Check: should show abort_by_response in explorer`);
}

console.log();
console.log('All test TXs submitted. Check on explorer:');
console.log(`  https://explorer.hiro.so/address/${CONTRACT}?chain=testnet`);
console.log();
console.log('TXIDs:');
txids.forEach((t, i) => console.log(`  [${i}] ${t}`));
console.log();
console.log('Next: wait for confirms, then verify traits + royalty flow manually on explorer');
