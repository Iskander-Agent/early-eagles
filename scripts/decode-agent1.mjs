import { getAddressFromPrivateKey } from '@stacks/transactions';
const MCP_BASE = '/home/ghislo/.aibtc/node_modules/@aibtc/mcp-server';

// Use stacksjs address utility from the MCP bundle
const { principalCV, addressToString } = await import('@stacks/transactions');

// The raw bytes from the contract response:
// 0x070a0516a11be198a7bc4ca2d45e0895ba7d0909bc1067f6
// Let's try a different approach: use Hiro's API to get the transfer events for token ID 1

// First, let's check if Tiny Marten (CEO) registered early and is accessible via known BNS
const names = ['tiny-marten.btc', 'tinymarten.btc', 'secret-mars.btc'];
for (const name of names) {
  const r = await fetch(`https://aibtc.com/api/agents/${name}`);
  const d = await r.json();
  if (d.found) {
    console.log(`${name}: ${d.agent?.displayName} | ${d.agent?.stxAddress} | ${d.agent?.btcAddress}`);
  }
}

// Try the on-chain events for the identity registry to find who minted token #1
const events = await fetch(
  'https://api.hiro.so/extended/v1/contract/SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2/events?limit=10&offset=0'
);
const ed = await events.json();
console.log('\nEarliest contract events:');
for (const e of (ed.results || []).slice(-5)) {
  console.log(JSON.stringify(e).slice(0,200));
}
