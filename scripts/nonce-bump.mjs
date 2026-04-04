import { readFileSync } from 'fs';
const MCP_BASE = '/home/ghislo/.aibtc/node_modules/@aibtc/mcp-server';
const API = 'https://api.testnet.hiro.so';
const { makeSTXTokenTransfer, AnchorMode } = await import('@stacks/transactions');
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
console.log('Address:', address);
// Send 1 uSTX to self at nonce 49 with high fee to replace stuck TX
const tx = await makeSTXTokenTransfer({
  recipient: 'ST1NXBK3K5YYMD6FD41MVNP3JS1GABZ8TRVX023PT', // testnet faucet addr
  amount: 1n,
  senderKey: privKey,
  network: STACKS_TESTNET,
  anchorMode: AnchorMode.Any,
  fee: 1200000n, // 1.2 STX — higher than stuck TX's 0.6 STX
  nonce: 49n,
  memo: 'nonce-bump',
});
const bytes = Buffer.from(tx.serialize(), 'hex');
const res = await fetch(`${API}/v2/transactions`, {
  method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
});
const text = await res.text();
console.log(res.status, text);
