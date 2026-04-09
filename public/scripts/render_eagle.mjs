#!/usr/bin/env node
/**
 * Early Eagles — On-Chain Renderer
 * Fetches all segments from the Stacks blockchain and assembles a complete HTML eagle card.
 *
 * Usage:
 *     node render_eagle.mjs <token_id>
 *     node render_eagle.mjs 0          // renders Frosty Narwhal
 *
 * Output:  eagle_<token_id>.html  (open in any browser)
 *
 * Zero dependencies — uses only Node.js built-ins (Node 18+).
 * Handles both plain string-ascii and response-ok wrapped Clarity values.
 *
 * Source: https://early-eagles.vercel.app
 */
import { writeFileSync } from "fs";

// ── Config ──────────────────────────────────────────────────────────
// These are the LIVE mainnet contracts.
// Both deployed from the same address on mainnet.
const NETWORK       = "mainnet";
const API           = "https://api.hiro.so";
const NFT_ADDR      = "SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2";
const NFT_NAME      = "early-eagles";
const RENDERER_ADDR = "SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2";
const RENDERER_NAME = "early-eagles-renderer";


// ── Clarity hex decoder ────────────────────────────────────────────
// The Hiro API returns Clarity values as hex strings.
// Two return types exist:
//   string-ascii         → 0x  0d  [4-byte len]  [ascii bytes]
//   (response ok string) → 0x  07  0d  [4-byte len]  [ascii bytes]
// The 07 is a response-ok wrapper. If not stripped, it corrupts output.
function clarityDecodeString(hexStr) {
  let h = hexStr.startsWith("0x") ? hexStr.slice(2) : hexStr;
  // Unwrap response-ok (0x07) if present
  if (h.slice(0, 2) === "07") h = h.slice(2);
  // Check for error response
  if (h.slice(0, 2) === "08") throw new Error(`Contract returned error: 0x${h.slice(0, 20)}...`);
  // Expect string-ascii (0d) or string-utf8 (0e)
  const typeByte = h.slice(0, 2);
  if (typeByte !== "0d" && typeByte !== "0e")
    throw new Error(`Expected string type (0d/0e), got 0x${typeByte}`);
  const length = parseInt(h.slice(2, 10), 16);
  const raw = h.slice(10, 10 + length * 2);
  if (raw.length !== length * 2)
    throw new Error(`Truncated: expected ${length} bytes, got ${raw.length / 2}`);
  return raw.match(/.{2}/g).map(b => String.fromCharCode(parseInt(b, 16))).join("");
}


// ── Hiro API caller ────────────────────────────────────────────────
async function callRead(contractAddr, contractName, fn, args = []) {
  const url = `${API}/v2/contracts/call-read/${contractAddr}/${contractName}/${fn}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: contractAddr, arguments: args }),
  });
  const data = await res.json();
  if (!data.okay) throw new Error(`API error on ${fn}: ${data.cause || JSON.stringify(data)}`);
  return data.result;
}

function uintCV(n) {
  return "0x01" + BigInt(n).toString(16).padStart(32, "0");
}


// ── Main ────────────────────────────────────────────────────────────
const tokenId = parseInt(process.argv[2]);
if (isNaN(tokenId)) {
  console.log("Usage: node render_eagle.mjs <token_id>");
  console.log("  e.g. node render_eagle.mjs 0");
  process.exit(1);
}

console.log(`Rendering Early Eagle #${tokenId}...`);
console.log(`  NFT:      ${NFT_ADDR}.${NFT_NAME}`);
console.log(`  Renderer: ${RENDERER_ADDR}.${RENDERER_NAME}`);

// Fetch the 4 renderer segments in parallel (same for every eagle)
console.log("  Fetching renderer segments...");
const [seg1Raw, eagleRaw, seg2Raw, seg3Raw] = await Promise.all([
  callRead(RENDERER_ADDR, RENDERER_NAME, "get-seg1"),
  callRead(RENDERER_ADDR, RENDERER_NAME, "get-eagle"),
  callRead(RENDERER_ADDR, RENDERER_NAME, "get-seg2"),
  callRead(RENDERER_ADDR, RENDERER_NAME, "get-seg3"),
]);

const seg1  = clarityDecodeString(seg1Raw);
const eagle = clarityDecodeString(eagleRaw);
const seg2  = clarityDecodeString(seg2Raw);
const seg3  = clarityDecodeString(seg3Raw);
console.log(`  Segments: ${seg1.length + eagle.length + seg2.length + seg3.length} bytes total`);

// Fetch per-token render params (this one returns response-ok wrapped)
console.log("  Fetching render params...");
const paramsRaw = await callRead(NFT_ADDR, NFT_NAME, "get-render-params", [uintCV(tokenId)]);
const params = clarityDecodeString(paramsRaw);
console.log(`  Params: ${params.length} bytes`);

// Assemble: seg1 + eagle + seg2 + renderParams + seg3
const html = seg1 + eagle + seg2 + params + seg3;

const outfile = `eagle_${tokenId}.html`;
writeFileSync(outfile, html, "utf-8");

console.log(`\n  Saved: ${outfile} (${html.length.toLocaleString()} bytes)`);
console.log("  Open in any browser to view your eagle.");
