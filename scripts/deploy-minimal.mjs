import { readFileSync } from 'fs';
const MCP_BASE = '/home/ghislo/.aibtc/node_modules/@aibtc/mcp-server';
const { makeContractDeploy, AnchorMode, PostConditionMode } = await import('@stacks/transactions');
const { STACKS_MAINNET } = await import('@stacks/network');
const { generateWallet } = await import('@stacks/wallet-sdk');
const { decrypt } = await import(`${MCP_BASE}/dist/utils/index.js`);

const source = readFileSync('/tmp/test-minimal.clar', 'utf8');
const env = readFileSync('/home/ghislo/.aibtc/.env', 'utf8');
const password = env.match(/AIBTC_WALLET_PASSWORD=(.+)/)[1].trim();
const keystore = JSON.parse(readFileSync('/home/ghislo/.aibtc/wallets/c5cd9b95-98b1-470f-8631-de5010ed126e/keystore.json', 'utf8'));
const mnemonic = (await decrypt(keystore.encrypted, password)).trim();
const wallet = await generateWallet({ secretKey: mnemonic, password: '' });
const privKey = wallet.accounts[0].stxPrivateKey;

const tx = await makeContractDeploy({
  contractName: 'ee-minimal-test',
  codeBody: source,
  senderKey: privKey,
  network: STACKS_MAINNET,
  anchorMode: AnchorMode.Any,
  postConditionMode: PostConditionMode.Allow,
  fee: 200000n,
});
const bytes = Buffer.from(tx.serialize(), 'hex');
const res = await fetch('https://api.hiro.so/v2/transactions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: bytes,
});
const text = await res.text();
console.log('Status:', res.status);
console.log('Result:', text.slice(0,200));
