/**
 * Deploy all Early Eagles contracts from admin account (index 1).
 * Order: commission-trait → commission-stx → commission-sbtc-testnet → renderer-v5 → NFT
 */
import { readFileSync } from 'fs';

const MCP_BASE = '/home/ghislo/.aibtc/node_modules/@aibtc/mcp-server';
const API = 'https://api.testnet.hiro.so';
const CONTRACTS_DIR = '/home/ghislo/workspace/nft/early-eagles/contracts';

const { makeContractDeploy, AnchorMode, PostConditionMode } = await import('@stacks/transactions');
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
console.log('Deploying from admin (account 1):', address);

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
  if (!res.ok) throw new Error(`Broadcast failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

async function deployContract(contractName, source, fee = 300000n) {
  const checkRes = await fetch(`${API}/v2/contracts/interface/${address}/${contractName}`);
  if (checkRes.ok) { console.log(`⏭  ${contractName} already deployed`); return null; }

  console.log(`Deploying ${contractName} (${source.length} chars, nonce ${nonce})...`);
  const tx = await makeContractDeploy({
    contractName, codeBody: source, senderKey: privKey,
    network: STACKS_TESTNET, anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow, fee, nonce: BigInt(nonce),
  });
  const txid = await broadcast(tx);
  console.log(`  ✅ ${txid}`);
  console.log(`  🔗 https://explorer.hiro.so/txid/${txid}?chain=testnet`);
  nonce++;
  await new Promise(r => setTimeout(r, 1500));
  return txid;
}

// Deploy helper contracts
await deployContract('commission-trait',        readFileSync(`${CONTRACTS_DIR}/commission-trait.clar`, 'utf8'),        200000n);
await deployContract('commission-stx',          readFileSync(`${CONTRACTS_DIR}/commission-stx.clar`, 'utf8'),          200000n);
await deployContract('commission-sbtc-testnet', readFileSync(`${CONTRACTS_DIR}/commission-sbtc-testnet.clar`, 'utf8'), 200000n);

// Deploy renderer-v5 (new contract file)
const rendererSrc = readFileSync(`${CONTRACTS_DIR}/early-eagles-renderer-v2.clar`, 'utf8');
await deployContract('early-eagles-renderer', rendererSrc, 300000n);

// Deploy NFT — update to point to new admin renderer
let nftSrc = readFileSync(`${CONTRACTS_DIR}/early-eagles-v2-testnet.clar`, 'utf8');
// Point to this admin address's renderer
nftSrc = nftSrc.replace(
  /ST3JR7JXFT7ZM9JKSQPBQG1HPT0D365MA5TX3DS8N\.early-eagles-renderer-v[0-9]+/,
  `${address}.early-eagles-renderer`
);
await deployContract('early-eagles', nftSrc, 600000n);

console.log('\n═══════════════════════════════════════');
console.log('✅ All contracts deployed from admin account!');
console.log(`Admin: ${address}`);
console.log(`NFT contract: ${address}.early-eagles`);
console.log(`Renderer: ${address}.early-eagles-renderer`);
console.log('\nNext: upload renderer segments, then mint reserved eagles');
