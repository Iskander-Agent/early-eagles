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
  const W = 260, H = 64;
  const uid = `ee${tier}`;

  const title = count > 1
    ? `EARLY EAGLES ×${count}`
    : `EARLY EAGLE #${tokenId}`;

  const nameBase = agentName || abbrev(address);
  const sub = truncate(alias ? `${alias} · ${nameBase}` : nameBase, 30);

  // Layout constants
  const ICON_X = 8, ICON_Y = 9, ICON_S = 22;
  const TEXT_X = ICON_X + ICON_S + 8;    // 38
  const PILL_W = 68, PILL_X = W - PILL_W - 8;  // 184

  const stxDisplay = abbrev(address);
  const btcDisplay = btcAddress ? abbrev(btcAddress) : null;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
     role="img" aria-label="${esc(title)}${agentName ? ' — ' + esc(agentName) : ''}">
  <title>${esc(title)}${agentName ? ' — ' + esc(agentName) : ''} · ${esc(t.name)}</title>
  <defs>
    <linearGradient id="${uid}bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0f1623"/>
      <stop offset="100%" stop-color="#090c12"/>
    </linearGradient>
    <radialGradient id="${uid}amb" cx="0" cy="0.5" r="0.45" fx="0" fy="0.5">
      <stop offset="0%" stop-color="${t.color}" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="${t.color}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${uid}sg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="white" stop-opacity="0"/>
      <stop offset="45%"  stop-color="white" stop-opacity="0"/>
      <stop offset="50%"  stop-color="white" stop-opacity="0.03"/>
      <stop offset="55%"  stop-color="white" stop-opacity="0"/>
      <stop offset="100%" stop-color="white" stop-opacity="0"/>
    </linearGradient>
    <filter id="${uid}gf" x="-400%" y="-100%" width="900%" height="300%">
      <feGaussianBlur stdDeviation="3.5" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <clipPath id="${uid}cl"><rect width="${W}" height="${H}" rx="6"/></clipPath>
  </defs>

  <style>
    @keyframes ${uid}sh {
      0%   { transform: translateX(-${W}px); }
      100% { transform: translateX(${W * 2}px); }
    }
    @keyframes ${uid}gl {
      0%, 100% { opacity: 0.38; }
      50%       { opacity: 0.8; }
    }
    @media (prefers-reduced-motion: reduce) {
      .${uid}sh, .${uid}gl { animation: none !important; }
    }
  </style>

  <g clip-path="url(#${uid}cl)">
    <rect width="${W}" height="${H}" fill="url(#${uid}bg)"/>
    <rect width="${W}" height="${H}" fill="url(#${uid}amb)"/>
    <rect width="${W}" height="${H}" rx="6" fill="none"
          stroke="${t.color}" stroke-width="0.5" stroke-opacity="0.2"/>

    <!-- Left accent bar — slow glow pulse -->
    <rect class="${uid}gl" x="0" y="0" width="3" height="${H}"
          fill="${t.color}" filter="url(#${uid}gf)"
          style="animation:${uid}gl 4s ease-in-out infinite;"/>

    <!-- Eagle icon box — vertically centered in header zone -->
    <rect x="${ICON_X}" y="${ICON_Y}" width="${ICON_S}" height="${ICON_S}" rx="5"
          fill="${t.dim}"/>
    <text x="${ICON_X + ICON_S / 2}" y="${ICON_Y + ICON_S / 2 + 5}"
          font-size="13" text-anchor="middle"
          font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,serif">🦅</text>

    <!-- Title -->
    <text x="${TEXT_X}" y="20"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="10.5" font-weight="700" fill="#edf0f7" letter-spacing="0.15">${esc(title)}</text>

    <!-- Sub (alias · agent name, or agent name, or address) -->
    <text x="${TEXT_X}" y="31"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="8.5" fill="#68788f">${esc(sub)}</text>

    <!-- Separator -->
    <line x1="${TEXT_X}" y1="37" x2="${PILL_X - 4}" y2="37"
          stroke="rgba(255,255,255,0.06)" stroke-width="0.5"/>

    <!-- STX address row -->
    <text x="${TEXT_X}" y="48"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7.5" font-weight="700" fill="${t.text}">STX</text>
    <text x="${TEXT_X + 20}" y="48"
          font-family="'SF Mono','Fira Code','Consolas',monospace"
          font-size="7.5" fill="#8a9ab8">${esc(stxDisplay)}</text>

    <!-- BTC address row -->
    ${btcDisplay ? `
    <text x="${TEXT_X}" y="58"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7.5" font-weight="700" fill="#f7931a">BTC</text>
    <text x="${TEXT_X + 20}" y="58"
          font-family="'SF Mono','Fira Code','Consolas',monospace"
          font-size="7.5" fill="#8a9ab8">${esc(btcDisplay)}</text>
    ` : ''}

    <!-- Tier pill -->
    <rect x="${PILL_X}" y="9" width="${PILL_W}" height="13" rx="3"
          fill="${t.dim}" stroke="${t.color}" stroke-width="0.4" stroke-opacity="0.4"/>
    <text x="${PILL_X + PILL_W / 2}" y="19"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="8" font-weight="700" fill="${t.text}" text-anchor="middle"
          letter-spacing="0.7">${esc(t.name.toUpperCase())}</text>

    <!-- On-Chain label -->
    <text x="${PILL_X + PILL_W / 2}" y="31"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7.5" fill="#00c96a" text-anchor="middle">✓ on-chain</text>

    <!-- Shimmer — very faint, slow sweep -->
    <rect class="${uid}sh" x="0" y="0" width="${W}" height="${H}"
          fill="url(#${uid}sg)"
          style="animation:${uid}sh 5s 1s linear infinite;"/>

    <a href="${esc(profileUrl)}" target="_blank">
      <rect width="${W}" height="${H}" fill="transparent" opacity="0"/>
    </a>
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
