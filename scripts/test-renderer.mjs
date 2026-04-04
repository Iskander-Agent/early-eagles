/**
 * test-renderer.mjs
 * Call get-card-html on testnet and save the result as an HTML file.
 * Open the file in a browser to verify the card renders correctly.
 */
import { readFileSync, writeFileSync } from 'fs';
import { deserializeCV, cvToJSON, stringAsciiCV, serializeCV } from '@stacks/transactions';

const API = 'https://api.testnet.hiro.so';

const MCP_BASE = '/home/ghislo/.aibtc/node_modules/@aibtc/mcp-server';
const env = readFileSync('/home/ghislo/.aibtc/.env', 'utf8');
const password = env.match(/AIBTC_WALLET_PASSWORD=(.+)/)[1].trim();
const { generateWallet } = await import('@stacks/wallet-sdk');
const { getAddressFromPrivateKey } = await import('@stacks/transactions');
const { decrypt } = await import(`${MCP_BASE}/dist/utils/index.js`);
const keystore = JSON.parse(readFileSync('/home/ghislo/.aibtc/wallets/c5cd9b95-98b1-470f-8631-de5010ed126e/keystore.json', 'utf8'));
const mnemonic = (await decrypt(keystore.encrypted, password)).trim();
const wallet = await generateWallet({ secretKey: mnemonic, password: '' });
const privKey = wallet.accounts[0].stxPrivateKey;
const address = getAddressFromPrivateKey(privKey, 'testnet');

// Build agent JSON for token #0 (Iskander, Legendary Gold)
const agentJson = '{"rank":124,"tier":0,"cid":10,"name":"Iskander","btc":"bc1qxj5jtv8jwm7zv2nczn2xfq9agjgj0sqpsxn43h"}';
const agentArg = Buffer.from(serializeCV(stringAsciiCV(agentJson))).toString('hex');

console.log('Calling get-card-html on:', `${address}.early-eagles-renderer`);
console.log('Agent:', agentJson);
console.log();

const res = await fetch(`${API}/v2/contracts/call-read/${address}/early-eagles-renderer/get-card-html`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sender: address, arguments: ['0x' + agentArg] }),
});

const data = await res.json();
if (!data.okay) {
  console.error('❌ Call failed:', data);
  process.exit(1);
}

const cv = deserializeCV(data.result);
const json = cvToJSON(cv);

if (json.type === '(response (string-ascii 70000) UnknownType)' || json.value?.value) {
  const html = json.value?.value || json.value;
  const outPath = '/home/ghislo/workspace/nft/early-eagles/renderer/onchain_card.html';
  writeFileSync(outPath, html);
  console.log(`✅ Card HTML received: ${html.length} chars`);
  console.log(`📄 Saved to: ${outPath}`);
  console.log('Open in browser to verify glassmorphism card renders correctly.');
} else {
  console.log('Raw result:', JSON.stringify(json, null, 2));
}
