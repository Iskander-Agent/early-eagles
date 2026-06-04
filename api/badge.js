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
const { sha256 } = require('@noble/hashes/sha256');

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function stxToBtcAddress(stxAddr) {
  try {
    const [, hashHex] = c32addressDecode(stxAddr);
    const hash = Buffer.from(hashHex, 'hex');
    const versioned = Buffer.concat([Buffer.from([0x00]), hash]);
    const checksum = Buffer.from(sha256(sha256(versioned))).slice(0, 4);
    const full = Buffer.concat([versioned, checksum]);
    let n = BigInt('0x' + full.toString('hex'));
    let result = '';
    while (n > 0n) { result = BASE58_ALPHABET[Number(n % 58n)] + result; n /= 58n; }
    for (const b of full) { if (b !== 0) break; result = '1' + result; }
    return result;
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
  // W=340 fits full STX address (42 chars × ~4.5px) with right margin for copy
  // H=80: header 48px (2 balanced rows) + 2 address rows 16px each
  const W = 340, H = 80;
  const uid = `ee${tier}`;

  const title = count > 1 ? `EARLY EAGLES ×${count}` : `EARLY EAGLE #${tokenId}`;
  const nameBase = agentName || abbrev(address);
  const sub = truncate(alias ? `${alias} · ${nameBase}` : nameBase, 28);

  // Two balanced header rows:
  //   Row A (y=0–26): icon  +  title left  |  tier pill right
  //   Row B (y=26–48): space + subtitle    |  on-chain · View Profile →
  // Address rows below the divider at y=48
  const HDR   = 48;
  const ROW1  = HDR;       // 48 — STX
  const ROW2  = HDR + 16;  // 64 — BTC

  // Tier pill right-aligned: 8px from right edge
  const PILL_W = 74, PILL_H = 16;
  const PILL_X = W - PILL_W - 8;   // 258
  const PILL_CX = PILL_X + PILL_W / 2;  // 295

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
    function ${uid}cp(id,v){if(!navigator.clipboard)return;navigator.clipboard.writeText(v).then(function(){var e=document.getElementById(id);if(!e)return;e.textContent='✓';setTimeout(function(){e.textContent='copy';},1600);});}
  ]]></script>

  <g clip-path="url(#${uid}cl)">
    <rect width="${W}" height="${H}" fill="url(#${uid}bg)"/>
    <rect x="0" y="0" width="4" height="${H}" fill="url(#${uid}bar)"/>
    <rect width="${W}" height="${H}" rx="10" fill="none"
          stroke="${t.color}" stroke-width="0.8" stroke-opacity="0.22"/>

    <!-- Header / address section divider -->
    <line x1="4" y1="${HDR}" x2="${W}" y2="${HDR}"
          stroke="rgba(255,255,255,0.08)" stroke-width="0.6"/>
    <!-- STX / BTC divider -->
    <line x1="12" y1="${ROW2}" x2="${W - 4}" y2="${ROW2}"
          stroke="rgba(255,255,255,0.04)" stroke-width="0.5"/>

    <!-- ── Header row A: icon + title  |  tier pill ──────────────────── -->

    <rect x="12" y="8" width="20" height="20" rx="4" fill="${t.dim}"/>
    <text x="22" y="23" font-size="12" text-anchor="middle"
          font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,serif">🦅</text>

    <!-- Title — left, vertically centered in row A (y=8–28) -->
    <text x="38" y="23"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="11" font-weight="700" fill="#eef3ff" letter-spacing="0.2">${esc(title)}</text>

    <!-- Tier pill — right-aligned, row A -->
    <rect x="${PILL_X}" y="8" width="${PILL_W}" height="${PILL_H}" rx="5"
          fill="${t.dim}" stroke="${t.color}" stroke-width="0.6" stroke-opacity="0.5"/>
    <text x="${PILL_CX}" y="${8 + PILL_H / 2 + 3}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7.5" font-weight="800" fill="${t.text}" text-anchor="middle"
          letter-spacing="1.2">${esc(t.name.toUpperCase())}</text>

    <!-- ── Header row B: subtitle  |  on-chain · profile link ────────── -->

    <!-- Subtitle — left, aligned under title at x=38 -->
    <text x="38" y="39"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="8.5" fill="#4a5c78">${esc(sub)}</text>

    <!-- ✓ on-chain — right, under tier pill -->
    <text x="${PILL_CX}" y="36"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7.5" fill="#00c97a" text-anchor="middle">✓ on-chain</text>

    <!-- View Profile → — right, row B bottom, inline under on-chain -->
    <a href="${esc(profileUrl)}" target="_blank">
      <rect x="${PILL_X}" y="40" width="${PILL_W}" height="10" rx="3"
            fill="rgba(255,255,255,0.04)" stroke="${t.color}" stroke-width="0.5" stroke-opacity="0.3"/>
      <text x="${PILL_CX}" y="48"
            font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
            font-size="6.5" fill="${t.text}" text-anchor="middle" opacity="0.85">View Profile →</text>
    </a>

    <!-- ── STX address row ─────────────────────────────────────────────── -->

    <text x="12" y="${ROW1 + 12}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="6.5" font-weight="700" letter-spacing="0.7" fill="${t.text}">STX</text>
    <text x="32" y="${ROW1 + 12}"
          font-family="'SF Mono','Fira Code','Consolas',monospace"
          font-size="7.5" fill="#8899b4">${esc(address)}</text>
    <g onclick="${uid}cp('${uid}sc','${address}')" style="cursor:pointer">
      <rect x="${W - 42}" y="${ROW1 + 3}" width="35" height="10" rx="3"
            fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.11)" stroke-width="0.5"/>
      <text id="${uid}sc" x="${W - 24.5}" y="${ROW1 + 11}"
            font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
            font-size="6.5" fill="rgba(255,255,255,0.4)" text-anchor="middle">copy</text>
    </g>

    <!-- ── BTC address row ─────────────────────────────────────────────── -->

    <text x="12" y="${ROW2 + 12}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="6.5" font-weight="700" letter-spacing="0.7" fill="#f7931a">BTC</text>
    ${btcAddress ? `
    <text x="32" y="${ROW2 + 12}"
          font-family="'SF Mono','Fira Code','Consolas',monospace"
          font-size="7.5" fill="#8899b4">${esc(btcAddress)}</text>
    <g onclick="${uid}cp('${uid}bc','${btcAddress}')" style="cursor:pointer">
      <rect x="${W - 42}" y="${ROW2 + 3}" width="35" height="10" rx="3"
            fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.11)" stroke-width="0.5"/>
      <text id="${uid}bc" x="${W - 24.5}" y="${ROW2 + 11}"
            font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
            font-size="6.5" fill="rgba(255,255,255,0.4)" text-anchor="middle">copy</text>
    </g>
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
