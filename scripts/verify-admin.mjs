import { readFileSync, writeFileSync } from 'fs';

const API = 'https://api.testnet.hiro.so';
const ADMIN = 'ST3HR09GX5YFDPP7271GG1Y9P4ZZ70DRE7H2AYYEM';
const NFT = 'early-eagles';
const RENDERER = 'early-eagles-renderer';

function decodeString(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const inner = h.startsWith('07') ? h.slice(2) : h;
  const type = inner.slice(0,2);
  if (type !== '0d' && type !== '0e') return null;
  const len = parseInt(inner.slice(2,10),16);
  return Buffer.from(inner.slice(10, 10+len*2).match(/.{2}/g).map(b=>parseInt(b,16))).toString('utf8');
}

function uintArg(n) { return '0x01' + BigInt(n).toString(16).padStart(32,'0'); }

async function callRead(contract, fn, args=[]) {
  const r = await fetch(`${API}/v2/contracts/call-read/${ADMIN}/${contract}/${fn}`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ sender: ADMIN, arguments: args })
  });
  return r.json();
}

console.log('Fetching renderer segments...');
const [s1r,er,s2r,s3r] = await Promise.all([
  callRead(RENDERER,'get-seg1'),
  callRead(RENDERER,'get-eagle'),
  callRead(RENDERER,'get-seg2'),
  callRead(RENDERER,'get-seg3'),
]);
const segs = {
  seg1: decodeString(s1r.result),
  eagle: decodeString(er.result),
  seg2: decodeString(s2r.result),
  seg3: decodeString(s3r.result),
};
console.log(`  seg1:${segs.seg1?.length} eagle:${segs.eagle?.length} seg2:${segs.seg2?.length} seg3:${segs.seg3?.length}\n`);

for (const tokenId of [0, 1]) {
  const rpRes = await callRead(NFT, 'get-render-params', [uintArg(tokenId)]);
  if (!rpRes.okay) { console.log(`Token ${tokenId}: not ready`); continue; }
  const inner = rpRes.result.slice(4);
  const agentJson = decodeString('0x' + inner);
  if (!agentJson) { console.log(`Token ${tokenId}: null`); continue; }
  console.log(`Token ${tokenId}: ${agentJson}`);
  const html = segs.seg1 + segs.eagle + segs.seg2 + agentJson + segs.seg3;
  const path = `/home/ghislo/workspace/nft/early-eagles/renderer/test-card-${tokenId}.html`;
  writeFileSync(path, html);
  console.log(`  → ${path} (${html.length} chars)\n`);
}
console.log('✅ Done');
