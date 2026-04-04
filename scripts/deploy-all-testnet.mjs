/**
 * deploy-all-testnet.mjs
 * Deploy all missing contracts to testnet in order:
 *   1. commission-trait
 *   2. commission-sbtc-testnet
 *   3. early-eagles-v2-testnet (NFT)
 *
 * commission-stx is already deployed.
 * early-eagles-renderer-v2 is already deployed and locked.
 */
import { readFileSync } from 'fs';

const MCP_BASE = '/home/ghislo/.aibtc/node_modules/@aibtc/mcp-server';
const API = 'https://api.testnet.hiro.so';
const CONTRACTS_DIR = '/home/ghislo/workspace/nft/early-eagles/contracts';

const { makeContractDeploy, AnchorMode, PostConditionMode } = await import('@stacks/transactions');
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

console.log('Deploying from:', address);

const acctRes = await fetch(`${API}/v2/accounts/${address}`);
const acct = await acctRes.json();
const stx = parseInt(acct.balance, 16) / 1e6;
let nonce = acct.nonce;
console.log(`Balance: ${stx} STX | Starting nonce: ${nonce}\n`);

async function broadcast(tx) {
  const bytes = Buffer.from(tx.serialize(), 'hex');
  const res = await fetch(`${API}/v2/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Broadcast failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

async function deployContract(contractName, file, fee = 300000n) {
  // Skip if already deployed
  const checkRes = await fetch(`${API}/v2/contracts/interface/${address}/${contractName}`);
  if (checkRes.ok) {
    console.log(`⏭  ${contractName} already deployed, skipping`);
    return null;
  }

  const source = readFileSync(`${CONTRACTS_DIR}/${file}`, 'utf8');
  console.log(`Deploying ${contractName} (${source.length} chars, nonce ${nonce})...`);

  const tx = await makeContractDeploy({
    contractName,
    codeBody: source,
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
  await new Promise(r => setTimeout(r, 1500));
  return txid;
}

// Deploy in order (dependencies first)
await deployContract('commission-trait',        'commission-trait.clar',        200000n);
await deployContract('commission-sbtc-testnet', 'commission-sbtc-testnet.clar', 200000n);
await deployContract('early-eagles-v2-testnet', 'early-eagles-v2-testnet.clar', 600000n);
await deployContract('early-eagles-v3-testnet', 'early-eagles-v2-testnet.clar', 600000n);
await deployContract('early-eagles-v4-testnet', 'early-eagles-v2-testnet.clar', 600000n);
await deployContract('early-eagles-v4-testnet', 'early-eagles-v2-testnet.clar', 600000n);

console.log('\n═══════════════════════════════════════');
console.log('✅ All contracts deployed!');
console.log(`\nNFT contract: ${address}.early-eagles-v2-testnet`);
console.log('Renderer:     ' + address + '.early-eagles-renderer-v2 (already live)');
console.log('\nWait ~2 min for confirmation, then run:');
console.log('  node scripts/test-mint-testnet.mjs');
await deployContract('early-eagles-v5-testnet', 'early-eagles-v2-testnet.clar', 600000n);
await deployContract('early-eagles-v6-testnet', 'early-eagles-v2-testnet.clar', 600000n);
