/**
 * Mint the 2 reserved Legendary eagles at deploy time.
 * Slot 0: Frosty Narwhal #1 (Legendary Azure) -> our STX address (mainnet: SP3JR7...)
 * Slot 1: Tiny Marten #2   (Legendary Gold)   -> their testnet proxy address
 *
 * On testnet we use our own address for both (no real money, just testing).
 * On mainnet slot 1 goes to SPKH9AWG0ENZ87J1X0PBD4HETP22G8W22AFNVF8K (Tiny Marten).
 */
import { readFileSync } from 'fs';

const MCP_BASE = '/home/ghislo/.aibtc/node_modules/@aibtc/mcp-server';
const API = 'https://api.testnet.hiro.so';
const ADMIN = 'ST3HR09GX5YFDPP7271GG1Y9P4ZZ70DRE7H2AYYEM';
const NFT = 'early-eagles';

const { makeContractCall, AnchorMode, PostConditionMode,
        uintCV, stringUtf8CV, stringAsciiCV, bufferCV, standardPrincipalCV } = await import('@stacks/transactions');
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
console.log('Minting from admin:', address);

// Check NFT contract is live
const iface = await fetch(`${API}/v2/contracts/interface/${ADMIN}/${NFT}`);
if (!iface.ok) { console.error('❌ NFT not confirmed yet'); process.exit(1); }
console.log('✅ NFT contract live\n');

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

async function airdrop(recipient, agentId, displayName, nameAscii, btc, tier, cid, label) {
  const sigil = Buffer.from(btc.slice(0,16).padEnd(16,'0'), 'ascii');
  console.log(`Minting ${label} (agent-id ${agentId}, tier ${tier}, cid ${cid}) -> ${recipient} (nonce ${nonce})...`);
  const tx = await makeContractCall({
    contractAddress: ADMIN, contractName: NFT,
    functionName: 'airdrop-mint',
    functionArgs: [
      standardPrincipalCV(recipient),
      uintCV(agentId),
      stringUtf8CV(displayName),
      stringAsciiCV(nameAscii),
      stringAsciiCV(btc),
      uintCV(tier),
      uintCV(cid),
      bufferCV(sigil),
    ],
    senderKey: privKey, network: STACKS_TESTNET,
    anchorMode: AnchorMode.Any, postConditionMode: PostConditionMode.Allow,
    fee: 300000n, nonce: BigInt(nonce),
  });
  const txid = await broadcast(tx);
  console.log(`  ✅ ${txid}`);
  console.log(`  🔗 https://explorer.hiro.so/txid/${txid}?chain=testnet`);
  nonce++;
  await new Promise(r => setTimeout(r, 1500));
}

// Slot 0: Frosty Narwhal — Legendary Azure (cid=0) — to our own testnet address
await airdrop(
  'ST3JR7JXFT7ZM9JKSQPBQG1HPT0D365MA5TX3DS8N', // testnet version of our mainnet SP3JR7...
  1, 'Frosty Narwhal', 'Frosty Narwhal',
  'bc1qxj5jtv8jwm7zv2nczn2xfq9agjgj0sqpsxn43h',
  0, 0, // Legendary, Azure
  'Frosty Narwhal #1 (Legendary Azure)'
);

// Slot 1: Tiny Marten — Legendary Gold (cid=10) — on testnet use our address as proxy
// Mainnet: SPKH9AWG0ENZ87J1X0PBD4HETP22G8W22AFNVF8K
await airdrop(
  'ST3JR7JXFT7ZM9JKSQPBQG1HPT0D365MA5TX3DS8N', // testnet proxy (mainnet: SPKH9AWG0...)
  2, 'Tiny Marten', 'Tiny Marten',
  'bc1qyu22hyqr406pus0g9jmfytk4ss5z8qsje74l76',
  0, 10, // Legendary, Gold
  'Tiny Marten #2 (Legendary Gold)'
);

console.log('\n✅ Both reserved Legendaries minted!');
console.log('Now run verify-render-testnet.mjs to check rendering.');
