/**
 * Test mint eagles on mainnet v5 contract
 * Usage: node scripts/test-mint.mjs
 */
import { readFileSync } from 'fs';
const MCP_BASE = '/home/ghislo/.aibtc/node_modules/@aibtc/mcp-server';
const MAINNET_API = 'https://api.hiro.so';
const CONTRACT_ADDRESS = 'SP3JR7JXFT7ZM9JKSQPBQG1HPT0D365MA5TN0P12E';
const CONTRACT_NAME = 'early-eagles-test-v5';

const { makeContractCall, AnchorMode, PostConditionMode, uintCV, stringUtf8CV, stringAsciiCV, standardPrincipalCV } = await import('@stacks/transactions');
const { STACKS_MAINNET } = await import('@stacks/network');
const { generateWallet } = await import('@stacks/wallet-sdk');
const { decrypt } = await import(`${MCP_BASE}/dist/utils/index.js`);
const { getAddressFromPrivateKey } = await import('@stacks/transactions');

const env = readFileSync('/home/ghislo/.aibtc/.env', 'utf8');
const password = env.match(/AIBTC_WALLET_PASSWORD=(.+)/)[1].trim();
const keystore = JSON.parse(readFileSync('/home/ghislo/.aibtc/wallets/c5cd9b95-98b1-470f-8631-de5010ed126e/keystore.json', 'utf8'));
const mnemonic = (await decrypt(keystore.encrypted, password)).trim();
const wallet = await generateWallet({ secretKey: mnemonic, password: '' });
const privKey = wallet.accounts[0].stxPrivateKey;
const address = getAddressFromPrivateKey(privKey, 'mainnet');

console.log('Minting as:', address);

// Test mints: 3 eagles with different tiers/colors
const testMints = [
  { name: 'Iskander', btc: 'bc1qxj5jtv8jwm7zv2nczn2xfq9agjgj0sqpsxn43h', agentId: 124, tier: 0, colorId: 12 }, // Legendary Gold
  { name: 'Frosty Narwhal', btc: 'bc1qxj5jtv8jwm7zv2nczn2xfq9agjgj0sqpsxn43h', agentId: 1, tier: 1, colorId: 1 }, // Epic Amethyst
  { name: 'Test Eagle', btc: 'bc1qtest000000000000000000000000000000000000', agentId: 42, tier: 4, colorId: 6 }, // Common Forest
];

async function broadcast(tx) {
  const bytes = Buffer.from(tx.serialize(), 'hex');
  const res = await fetch(`${MAINNET_API}/v2/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Broadcast failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

for (const mint of testMints) {
  console.log(`\nMinting: ${mint.name} (tier ${mint.tier}, color ${mint.colorId})...`);
  const tx = await makeContractCall({
    contractAddress: CONTRACT_ADDRESS,
    contractName: CONTRACT_NAME,
    functionName: 'test-mint',
    functionArgs: [
      standardPrincipalCV(address),
      stringUtf8CV(mint.name),
      stringAsciiCV(mint.btc),
      uintCV(mint.agentId),
      uintCV(mint.tier),
      uintCV(mint.colorId),
    ],
    senderKey: privKey,
    network: STACKS_MAINNET,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
    fee: 100000n,
  });
  const txid = await broadcast(tx);
  console.log(`  TX: ${txid}`);
  console.log(`  https://explorer.hiro.so/txid/${txid}?chain=mainnet`);
  
  // Small delay between mints
  await new Promise(r => setTimeout(r, 3000));
}

console.log('\nDone! Check the gallery at https://early-eagles.vercel.app/gallery');
