import { readFileSync } from 'fs';
const MCP_BASE = '/home/ghislo/.aibtc/node_modules/@aibtc/mcp-server';
const { generateWallet, generateNewAccount } = await import('@stacks/wallet-sdk');
const { getAddressFromPrivateKey } = await import('@stacks/transactions');
const { decrypt } = await import(`${MCP_BASE}/dist/utils/index.js`);
const env = readFileSync('/home/ghislo/.aibtc/.env', 'utf8');
const password = env.match(/AIBTC_WALLET_PASSWORD=(.+)/)[1].trim();
const keystore = JSON.parse(readFileSync('/home/ghislo/.aibtc/wallets/c5cd9b95-98b1-470f-8631-de5010ed126e/keystore.json', 'utf8'));
const mnemonic = (await decrypt(keystore.encrypted, password)).trim();

let wallet = await generateWallet({ secretKey: mnemonic, password: '' });
wallet = generateNewAccount(wallet); // derive account index 1

for (let i = 0; i < wallet.accounts.length; i++) {
  const privKey = wallet.accounts[i].stxPrivateKey;
  const mainnet = getAddressFromPrivateKey(privKey, 'mainnet');
  const testnet = getAddressFromPrivateKey(privKey, 'testnet');
  console.log(`Account ${i}: mainnet=${mainnet}`);
  console.log(`          testnet=${testnet}`);
}
