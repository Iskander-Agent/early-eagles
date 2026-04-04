/**
 * test-mint-testnet.mjs
 * Mint 3 test eagles on early-eagles-v6-testnet:
 *   Token 0: Iskander #124 — Legendary Gold
 *   Token 1: Frosty Narwhal #1 — Epic Amethyst
 *   Token 2: Test Eagle #42 — Common Forest
 *
 * Then reads back traits + render-params to verify.
 */
import { readFileSync } from 'fs';

const MCP_BASE = '/home/ghislo/.aibtc/node_modules/@aibtc/mcp-server';
const API = 'https://api.testnet.hiro.so';
const ADDR = 'ST3JR7JXFT7ZM9JKSQPBQG1HPT0D365MA5TX3DS8N';
const NFT = 'early-eagles-v6-testnet';

const { makeContractCall, AnchorMode, PostConditionMode,
        uintCV, stringUtf8CV, stringAsciiCV, bufferCV } = await import('@stacks/transactions');
const { STACKS_TESTNET } = await import('@stacks/network');
const { generateWallet } = await import('@stacks/wallet-sdk');
const { getAddressFromPrivateKey } = await import('@stacks/transactions');
const { decrypt } = await import(`${MCP_BASE}/dist/utils/index.js`);

const env = readFileSync('/home/ghislo/.aibtc/.env', 'utf8');
const password = env.match(/AIBTC_WALLET_PASSWORD=(.+)/)[1].trim();
const keystore = JSON.parse(readFileSync('/home/ghislo/.aibtc/wallets/c5cd9b95-98b1-470f-8631-de5010ed126e/keystore.json', 'utf8'));
const mnemonic = (await decrypt(keystore.encrypted, password)).trim();
const wallet = await generateWallet({ secretKey: mnemonic, password: '' });
const privKey = wallet.accounts[0].stxPrivateKey;
const address = getAddressFromPrivateKey(privKey, 'testnet');

console.log('Minting as:', address);

// Check contract is live
const ifaceRes = await fetch(`${API}/v2/contracts/interface/${ADDR}/${NFT}`);
if (!ifaceRes.ok) {
  console.error('❌ NFT contract not deployed yet! Wait for confirmation.');
  process.exit(1);
}
console.log('✅ NFT contract confirmed\n');

const acctRes = await fetch(`${API}/v2/accounts/${address}`);
const acct = await acctRes.json();
let nonce = acct.nonce;
console.log(`Balance: ${parseInt(acct.balance,16)/1e6} STX | Starting nonce: ${nonce}\n`);

async function broadcast(tx) {
  const bytes = Buffer.from(tx.serialize(), 'hex');
  const res = await fetch(`${API}/v2/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Broadcast failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

const testMints = [
  { agentId: 124, name: 'Iskander',       btc: 'bc1qxj5jtv8jwm7zv2nczn2xfq9agjgj0sqpsxn43h', tier: 0, colorId: 10 }, // Legendary Gold
  { agentId: 1,   name: 'Tiny Marten',    btc: 'bc1qtestmarten000000000000000000000000000000', tier: 1, colorId: 1  }, // Epic Amethyst
  { agentId: 42,  name: 'Test Eagle',     btc: 'bc1qtestea0000000000000000000000000000000000', tier: 4, colorId: 6  }, // Common Forest
];

const txids = [];
for (const m of testMints) {
  // sigil seed from btc addr bytes (first 16 chars as ascii bytes)
  const sigilSeed = Buffer.from(m.btc.slice(0, 16), 'ascii');

  console.log(`Minting #${m.agentId} ${m.name} (tier ${m.tier}, color ${m.colorId}, nonce ${nonce})...`);
  const tx = await makeContractCall({
    contractAddress: ADDR,
    contractName: NFT,
    functionName: 'claim',
    functionArgs: [
      uintCV(m.agentId),
      stringUtf8CV(m.name),
      stringAsciiCV(m.name.replace(/[^\x20-\x7E]/g, '?')), // name-ascii: frozen at mint
      stringAsciiCV(m.btc),
      uintCV(m.tier),
      uintCV(m.colorId),
      bufferCV(sigilSeed),
    ],
    senderKey: privKey,
    network: STACKS_TESTNET,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
    fee: 300000n,
    nonce: BigInt(nonce),
  });

  const txid = await broadcast(tx);
  console.log(`  ✅ ${txid}`);
  console.log(`  🔗 https://explorer.hiro.so/txid/${txid}?chain=testnet`);
  txids.push(txid);
  nonce++;
  await new Promise(r => setTimeout(r, 1500));
}

console.log('\n3 mint TXs broadcast. Wait ~2 min for confirmation, then run:');
console.log('  node scripts/verify-render-testnet.mjs');
