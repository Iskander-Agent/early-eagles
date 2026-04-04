/**
 * verify-render-testnet.mjs
 * After minting, reads back traits + render-params for tokens 0,1,2.
 * Assembles the full HTML card off-chain using renderer segments.
 * Writes test cards to renderer/test-card-{n}.html
 */
import { readFileSync, writeFileSync } from 'fs';

const API = 'https://api.testnet.hiro.so';
const ADDR = 'ST3JR7JXFT7ZM9JKSQPBQG1HPT0D365MA5TX3DS8N';
const NFT = 'early-eagles-v6-testnet';
const RENDERER = 'early-eagles-renderer-v4';

function decodeString(hexResult) {
  const hex = hexResult.startsWith('0x') ? hexResult.slice(2) : hexResult;
  const type = hex.slice(0, 2);
  if (type === '09') return null; // none
  // 0d = string-ascii, 0e = string-utf8
  const len = parseInt(hex.slice(2, 10), 16);
  return Buffer.from(hex.slice(10, 10 + len * 2), 'hex').toString('utf8');
}

function uintCV(n) {
  return '0x' + '01' + BigInt(n).toString(16).padStart(32,'0');
}

async function callRead(contract, fn, args = []) {
  const r = await fetch(`${API}/v2/contracts/call-read/${ADDR}/${contract}/${fn}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: ADDR, arguments: args }),
  });
  return r.json();
}

console.log('Fetching renderer segments...');
const [s1r, er, s2r, s3r] = await Promise.all([
  callRead(RENDERER, 'get-seg1'),
  callRead(RENDERER, 'get-eagle'),
  callRead(RENDERER, 'get-seg2'),
  callRead(RENDERER, 'get-seg3'),
]);
const seg1  = decodeString(s1r.result);
const eagle = decodeString(er.result);
const seg2  = decodeString(s2r.result);
const seg3  = decodeString(s3r.result);
console.log(`  seg1: ${seg1?.length} | eagle: ${eagle?.length} | seg2: ${seg2?.length} | seg3: ${seg3?.length}\n`);

for (const tokenId of [0, 1, 2]) {
  // get-render-params
  const rpRes = await callRead(NFT, 'get-render-params', [uintCV(tokenId)]);
  if (!rpRes.okay || rpRes.result === '0x08') {
    console.log(`Token ${tokenId}: not minted yet`);
    continue;
  }

  // Decode the (ok "...") result: 07 = ok, then string
  const inner = rpRes.result.slice(4); // skip 0x07
  const agentJson = decodeString('0x' + inner);
  console.log(`Token ${tokenId}: agentJson = ${agentJson}`);

  // Assemble HTML
  const html = seg1 + eagle + seg2 + agentJson + seg3;
  const outPath = `/home/ghislo/workspace/nft/early-eagles/renderer/test-card-${tokenId}.html`;
  writeFileSync(outPath, html);
  console.log(`  Wrote ${html.length} chars to ${outPath}\n`);
}

console.log('✅ Done — open the test-card-*.html files in a browser to verify rendering!');
