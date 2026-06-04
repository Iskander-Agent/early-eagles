/**
 * Early Eagles — /api/badge → SVG holder badge
 *
 * GET /api/badge?address=SP...
 * GET /api/badge/SP...        (via vercel.json rewrite)
 *
 * Returns an SVG badge showing Eagle holder status.
 * Embed in GitHub READMEs, agent profiles, bios:
 *   <img src="https://early-eagles.vercel.app/api/badge/SP..." alt="Early Eagle holder"/>
 *   ![Early Eagle](https://early-eagles.vercel.app/api/badge/SP...)
 *
 * Cache-Control: 3600s (tier/name stable; set lower if collection transfers frequently)
 * Non-holders: 404 + a minimal "no eagle" SVG
 */

const STACKS_API   = 'https://api.hiro.so';
const BASE_URL     = 'https://early-eagles.vercel.app';
const ADMIN_ADDRESS = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2';
const NFT_CONTRACT  = 'early-eagles-v2';

const TIERS = [
  { name: 'Legendary', color: '#d4a84b', dim: 'rgba(212,168,75,0.18)',  text: '#e8c26a' },
  { name: 'Epic',      color: '#a855f7', dim: 'rgba(168,85,247,0.18)',  text: '#c084fc' },
  { name: 'Rare',      color: '#0ea5e9', dim: 'rgba(14,165,233,0.18)',  text: '#7dd3fc' },
  { name: 'Uncommon',  color: '#10b981', dim: 'rgba(16,185,129,0.18)',  text: '#6ee7b7' },
  { name: 'Common',    color: '#6b7280', dim: 'rgba(107,114,128,0.18)', text: '#9ca3af' },
];

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

const { c32address, c32addressDecode } = require('c32check');
// Derive native segwit P2WPKH (bc1q...) from STX address — same hash160, bech32 encoded
function stxToBtcAddress(stxAddr) {
  try {
    const [, hashHex] = c32addressDecode(stxAddr);
    const hash20 = Buffer.from(hashHex, 'hex');
    const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    function polymod(v) {
      let chk = 1;
      for (const x of v) { const b = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i]; }
      return chk;
    }
    function hrpExpand(hrp) { const r = []; for (const c of hrp) r.push(c.charCodeAt(0) >> 5); r.push(0); for (const c of hrp) r.push(c.charCodeAt(0) & 31); return r; }
    function convertbits(data, from, to) {
      let acc = 0, bits = 0; const ret = [], maxv = (1 << to) - 1;
      for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; ret.push((acc >> bits) & maxv); } }
      if (bits > 0) ret.push((acc << (to - bits)) & maxv);
      return ret;
    }
    const hrp = 'bc', data = [0, ...convertbits(hash20, 8, 5)];
    const chk = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
    const enc = data.map(d => CHARSET[d]).join('') + [0,1,2,3,4,5].map(p => CHARSET[(chk >> (5*(5-p))) & 31]).join('');
    return hrp + '1' + enc;
  } catch { return null; }
}
const { fetchCallReadOnlyFunction, cvToValue } = require('@stacks/transactions');
const { STACKS_MAINNET } = require('@stacks/network');

function abort(ms) { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; }

// Decode (response (optional (principal))) hex → full SP address or null
function decodeOwnerFull(hexResult) {
  try {
    let hex = (hexResult || '').replace('0x', '');
    let i = 0;
    if (hex.slice(i, i + 2) === '07') i += 2; // response ok
    if (hex.slice(i, i + 2) === '0a') i += 2; // optional some
    if (hex.slice(i, i + 2) !== '05') return null; // not a standard principal
    i += 2;
    const versionByte = parseInt(hex.slice(i, i + 2), 16);
    const hashHex = hex.slice(i + 2, i + 42);
    return c32address(versionByte, hashHex);
  } catch { return null; }
}

function encodeUint(n) {
  return '0x01' + n.toString(16).padStart(32, '0');
}

async function callRead(fn, args = []) {
  const url = `${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDRESS}/${NFT_CONTRACT}/${fn}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: ADMIN_ADDRESS, arguments: args }),
    signal: abort(7000),
  });
  if (!r.ok) throw new Error(`callRead ${fn} → ${r.status}`);
  return r.json();
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function abbrev(addr) {
  if (!addr || addr.length < 14) return addr;
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

// The Hiro NFT holdings indexer does not index SIP-018 admin-broadcast mints.
// Instead: get total minted from contract, then fan-out get-owner calls.
async function getTokenIdsByOwner(address) {
  // 1. Get total minted
  const statsCV = await fetchCallReadOnlyFunction({
    contractAddress: ADMIN_ADDRESS,
    contractName: NFT_CONTRACT,
    functionName: 'get-mint-stats',
    functionArgs: [],
    senderAddress: ADMIN_ADDRESS,
    network: STACKS_MAINNET,
  });
  const stats = cvToValue(statsCV);
  const totalMinted = parseInt(stats['total-minted']?.value ?? stats['total-minted'], 10) || 0;
  if (totalMinted === 0) return [];

  // 2. Fan-out get-owner calls in parallel (batch of 10 to avoid rate limits)
  const ids = Array.from({ length: totalMinted }, (_, i) => i);
  const owned = [];

  for (let batch = 0; batch < ids.length; batch += 10) {
    const chunk = ids.slice(batch, batch + 10);
    const results = await Promise.allSettled(
      chunk.map(async id => {
        const data = await callRead('get-owner', [encodeUint(id)]);
        const owner = data.okay ? decodeOwnerFull(data.result) : null;
        return owner === address ? id : null;
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value !== null) owned.push(r.value);
    }
    // Small delay between batches to respect Hiro rate limits
    if (batch + 10 < ids.length) await new Promise(r => setTimeout(r, 300));
  }

  return owned.sort((a, b) => a - b);
}

async function getTokenMeta(id) {
  try {
    const r = await fetch(`${BASE_URL}/api/token/${id}`, { signal: abort(6000) });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

/* ── SVG builder ──────────────────────────────────────────────────────────── */

function buildBadge({ tokenId, count, tier, agentName, alias, address, btcAddress, profileUrl }) {
  const t = TIERS[tier] ?? TIERS[4];
  // Full-width two-row header — no vertical column split.
  // Row A: icon + title (left)  |  tier pill (right)
  // Row B: subtitle · ✓ on-chain (left-to-center)  View Profile → (right)
  // Each row uses the FULL width so neither side feels dense or empty.
  const W = 340, H = 64;
  const uid = `ee${tier}`;

  const title = count > 1 ? `EARLY EAGLES ×${count}` : `EARLY EAGLE #${tokenId}`;
  const nameBase = agentName || abbrev(address);
  const sub = truncate(alias ? `${alias} · ${nameBase}` : nameBase, 26);

  // Tier pill right-aligned in row A
  const PILL_W = 72, PILL_H = 16;
  const PILL_X = W - PILL_W - 8;
  const PILL_CX = PILL_X + PILL_W / 2;

  // Single address row — HDR divider, one row spanning STX + BTC side-by-side
  const HDR = 45;
  const ADDR_Y = HDR + 14;  // 59 — address text baseline

  // Copy icon helper — two overlapping squares (clipboard), compact 7×7 footprint
  const copyIcon = (ix, iy, confirmId, val) => `
    <g onclick="${uid}cp('${confirmId}','${val}')" style="cursor:pointer">
      <rect x="${ix}"   y="${iy+2}" width="5" height="5" rx="0.8"
            fill="#0d1525" stroke="rgba(255,255,255,0.18)" stroke-width="0.6"/>
      <rect x="${ix+2}" y="${iy}"   width="5" height="5" rx="0.8"
            fill="#0d1525" stroke="rgba(255,255,255,0.32)" stroke-width="0.6"/>
      <text id="${confirmId}" x="${ix+4.5}" y="${iy+5.5}"
            font-family="-apple-system,BlinkMacSystemFont,sans-serif"
            font-size="5.5" font-weight="700" fill="#00c97a" text-anchor="middle"></text>
    </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
     role="img" aria-label="${esc(title)}${agentName ? ' — ' + esc(agentName) : ''}">
  <title>${esc(title)}${agentName ? ' — ' + esc(agentName) : ''} · ${esc(t.name)}</title>
  <defs>
    <linearGradient id="${uid}bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#0d1525"/>
      <stop offset="100%" stop-color="#08101e"/>
    </linearGradient>
    <linearGradient id="${uid}bar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="${t.color}"/>
      <stop offset="100%" stop-color="${t.color}" stop-opacity="0.35"/>
    </linearGradient>
    <clipPath id="${uid}cl"><rect width="${W}" height="${H}" rx="10"/></clipPath>
  </defs>

  <script type="text/javascript"><![CDATA[
    function ${uid}cp(id,v){if(!navigator.clipboard)return;navigator.clipboard.writeText(v).then(function(){var e=document.getElementById(id);if(!e)return;e.textContent='✓';setTimeout(function(){e.textContent='';},1600);});}
  ]]></script>

  <g clip-path="url(#${uid}cl)">
    <rect width="${W}" height="${H}" fill="url(#${uid}bg)"/>
    <rect x="0" y="0" width="4" height="${H}" fill="url(#${uid}bar)"/>
    <rect width="${W}" height="${H}" rx="10" fill="none"
          stroke="${t.color}" stroke-width="0.8" stroke-opacity="0.22"/>

    <!-- Header / address divider -->
    <line x1="4" y1="${HDR}" x2="${W}" y2="${HDR}"
          stroke="rgba(255,255,255,0.08)" stroke-width="0.6"/>

    <!-- ── Row A: icon · title LEFT  |  tier pill RIGHT ─────────────── -->

    <rect x="12" y="7" width="18" height="18" rx="4" fill="${t.dim}"/>
    <text x="21" y="20" font-size="11" text-anchor="middle"
          font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,serif">🦅</text>

    <text x="36" y="21"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="11" font-weight="700" fill="#eef3ff" letter-spacing="0.2">${esc(title)}</text>

    <rect x="${PILL_X}" y="7" width="${PILL_W}" height="${PILL_H}" rx="5"
          fill="${t.dim}" stroke="${t.color}" stroke-width="0.6" stroke-opacity="0.5"/>
    <text x="${PILL_CX}" y="${7 + PILL_H / 2 + 3}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7.5" font-weight="800" fill="${t.text}" text-anchor="middle"
          letter-spacing="1.2">${esc(t.name.toUpperCase())}</text>

    <!-- ── Row B: subtitle · ✓ on-chain  ·  View Profile → (all inline) ─ -->

    <text x="36" y="37"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="8.5" fill="#4a5c78">${esc(sub)}</text>

    <text x="178" y="37"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7" fill="#00c97a">· ✓ on-chain</text>

    <a href="${esc(profileUrl)}" target="_blank">
      <text x="${W - 8}" y="37"
            font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
            font-size="7" fill="${t.text}" text-anchor="end" opacity="0.8">View Profile →</text>
    </a>

    <!-- ── Single address row: STX left  ·  BTC right ────────────────── -->
    <!-- Addresses abbreviated (abbrev: 8+…+6 chars) at larger 9px font. -->
    <!-- Copy icon = two overlapping squares (clipboard). No text label.  -->

    <text x="12" y="${ADDR_Y}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7" font-weight="700" letter-spacing="0.6" fill="${t.text}">STX</text>
    <text x="30" y="${ADDR_Y}"
          font-family="'SF Mono','Fira Code','Consolas',monospace"
          font-size="9" fill="#8899b4">${esc(abbrev(address))}</text>
    ${copyIcon(114, HDR + 3, `${uid}sc`, address)}

    ${btcAddress ? `
    <text x="134" y="${ADDR_Y}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7" font-weight="700" letter-spacing="0.6" fill="#f7931a">BTC</text>
    <text x="152" y="${ADDR_Y}"
          font-family="'SF Mono','Fira Code','Consolas',monospace"
          font-size="9" fill="#8899b4">${esc(abbrev(btcAddress))}</text>
    ${copyIcon(236, HDR + 3, `${uid}bc`, btcAddress)}
    ` : ''}
  </g>
</svg>`;
}

function errorSVG(message, status) {
  const color = status === 404 ? '#4a5568' : '#ff4d6a';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="280" height="40" viewBox="0 0 280 40">
  <rect width="280" height="40" rx="6" fill="#0d1117" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>
  <text x="140" y="25" font-family="Inter,Arial,sans-serif" font-size="12"
        fill="${color}" text-anchor="middle">${esc(message)}</text>
</svg>`;
}

/* ── Handler ──────────────────────────────────────────────────────────────── */

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Content-Type', 'image/svg+xml');

  if (req.method === 'OPTIONS') return res.status(204).end();

  // Accept address from query param (set by vercel.json rewrite or direct call)
  let address = String((req.query || {}).address || '').trim();

  // Optional alias — shown as "Alias · Agent Name" in the subtitle
  const alias = String((req.query || {}).alias || '')
    .trim()
    .replace(/[^ -~]/g, '')   // strip non-ASCII-printable
    .replace(/[<>&"\\]/g, '') // strip SVG-unsafe chars
    .slice(0, 20) || null;

  // Optional BTC address override (otherwise derived from STX address)
  const btcOverride = String((req.query || {}).btc || '')
    .trim()
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 62) || null;

  if (!address) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).send(errorSVG('Missing ?address= parameter', 400));
  }

  // Normalize testnet → mainnet prefix
  if (address.startsWith('ST')) address = 'SP' + address.slice(2);

  if (!/^S[PM][A-Z0-9]{38,41}$/.test(address)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).send(errorSVG('Invalid Stacks address', 400));
  }

  // Fetch token IDs via contract calls (Hiro indexer doesn't cover SIP-018 mints)
  let tokenIds;
  try {
    tokenIds = await getTokenIdsByOwner(address);
  } catch {
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.status(503).send(errorSVG('Chain unavailable — try again', 503));
  }

  if (tokenIds.length === 0) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(404).send(errorSVG('No Early Eagles held', 404));
  }

  // Fetch metadata for the first (lowest id) token
  const primaryId = tokenIds[0];
  let tier = 4, agentName = null;
  const meta = await getTokenMeta(primaryId);
  if (meta?.properties) {
    tier = meta.properties.tier ?? 4;
    agentName = meta.properties.display_name || null;
  }

  const btcAddress = btcOverride || stxToBtcAddress(address);
  const profileUrl = `${BASE_URL}/eagle/${primaryId}`;
  const svg = buildBadge({ tokenId: primaryId, count: tokenIds.length, tier, agentName, alias, address, btcAddress, profileUrl });

  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=600');
  return res.status(200).send(svg);
};
