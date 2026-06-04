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
  // Card dimensions — wide enough for addresses side-by-side, proportional height
  const W = 340, H = 76;
  const uid = `ee${tier}`;

  const title = count > 1 ? `EARLY EAGLES ×${count}` : `EARLY EAGLE #${tokenId}`;
  const nameBase = agentName || abbrev(address);
  const sub = truncate(alias ? `${alias} · ${nameBase}` : nameBase, 34);

  // Short address for footer strip — first 6 + … + last 4
  const addrShort = s => s && s.length > 12 ? s.slice(0, 6) + '…' + s.slice(-4) : (s || '');

  // Zone boundary
  const ZONE2_Y = 50;
  // Vertical separator before tier column
  const SEP_X   = 266;
  // Tier pill
  const PILL_X  = 274, PILL_W = 58, PILL_H = 16;
  const PILL_CX = PILL_X + PILL_W / 2;  // 303

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
     role="img" aria-label="${esc(title)}${agentName ? ' — ' + esc(agentName) : ''}">
  <title>${esc(title)}${agentName ? ' — ' + esc(agentName) : ''} · ${esc(t.name)}</title>
  <defs>
    <!-- Card background: deep navy, very subtle top highlight -->
    <linearGradient id="${uid}bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#0e1625"/>
      <stop offset="100%" stop-color="#080d18"/>
    </linearGradient>
    <!-- Tier ambient glow radiating from left edge -->
    <radialGradient id="${uid}amb" cx="0.02" cy="0.45" r="0.6">
      <stop offset="0%"   stop-color="${t.color}" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="${t.color}" stop-opacity="0"/>
    </radialGradient>
    <!-- Left accent bar: solid at top, fades at bottom -->
    <linearGradient id="${uid}bar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="${t.color}"/>
      <stop offset="100%" stop-color="${t.color}" stop-opacity="0.45"/>
    </linearGradient>
    <!-- Footer zone tint -->
    <linearGradient id="${uid}f2" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#050a14"/>
      <stop offset="100%" stop-color="#04080f"/>
    </linearGradient>
    <clipPath id="${uid}cl"><rect width="${W}" height="${H}" rx="8"/></clipPath>
  </defs>

  <g clip-path="url(#${uid}cl)">
    <!-- Base card -->
    <rect width="${W}" height="${H}" fill="url(#${uid}bg)"/>
    <!-- Tier ambient glow -->
    <rect width="${W}" height="${H}" fill="url(#${uid}amb)"/>

    <!-- Footer zone — darker tint to separate address strip -->
    <rect x="4" y="${ZONE2_Y}" width="${W - 4}" height="${H - ZONE2_Y}"
          fill="url(#${uid}f2)" opacity="0.9"/>

    <!-- Left accent bar -->
    <rect x="0" y="0" width="4" height="${H}" fill="url(#${uid}bar)"/>

    <!-- Card border — tier color, subtle -->
    <rect width="${W}" height="${H}" rx="8" fill="none"
          stroke="${t.color}" stroke-width="0.8" stroke-opacity="0.24"/>

    <!-- Zone divider -->
    <line x1="4" y1="${ZONE2_Y}" x2="${W}" y2="${ZONE2_Y}"
          stroke="rgba(255,255,255,0.07)" stroke-width="0.6"/>

    <!-- ── Identity section ────────────────────────────────────────────── -->

    <!-- Eagle icon box -->
    <rect x="13" y="11" width="28" height="28" rx="6" fill="${t.dim}"/>
    <text x="27" y="30" font-size="16" text-anchor="middle"
          font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,serif">🦅</text>

    <!-- Title: collection + token number -->
    <text x="51" y="25"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="11" font-weight="700" fill="#eef2ff" letter-spacing="0.25">${esc(title)}</text>

    <!-- Subtitle: alias · agent name -->
    <text x="51" y="38"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="9" fill="#4e607c">${esc(sub)}</text>

    <!-- ── Tier column ─────────────────────────────────────────────────── -->

    <!-- Vertical separator -->
    <line x1="${SEP_X}" y1="10" x2="${SEP_X}" y2="${ZONE2_Y - 7}"
          stroke="rgba(255,255,255,0.08)" stroke-width="0.7"/>

    <!-- Tier pill -->
    <rect x="${PILL_X}" y="12" width="${PILL_W}" height="${PILL_H}" rx="5"
          fill="${t.dim}" stroke="${t.color}" stroke-width="0.6" stroke-opacity="0.5"/>
    <text x="${PILL_CX}" y="${12 + PILL_H / 2 + 3.2}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7.5" font-weight="800" fill="${t.text}" text-anchor="middle"
          letter-spacing="1.1">${esc(t.name.toUpperCase())}</text>

    <!-- On-chain verified -->
    <text x="${PILL_CX}" y="40"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7.5" fill="#00c97a" text-anchor="middle" letter-spacing="0.2">✓ on-chain</text>

    <!-- ── Address strip (footer) ──────────────────────────────────────── -->

    <!-- STX label + address -->
    <text x="48" y="67"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7" font-weight="700" letter-spacing="0.6" fill="${t.text}">STX</text>
    <text x="67" y="67"
          font-family="'SF Mono','Fira Code','Consolas',monospace"
          font-size="7.5" fill="#4e6078">${esc(addrShort(address))}</text>

    ${btcAddress ? `
    <!-- Dot separator -->
    <circle cx="140" cy="63.5" r="1.6" fill="rgba(255,255,255,0.1)"/>

    <!-- BTC label + address -->
    <text x="150" y="67"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7" font-weight="700" letter-spacing="0.6" fill="#f7931a">BTC</text>
    <text x="170" y="67"
          font-family="'SF Mono','Fira Code','Consolas',monospace"
          font-size="7.5" fill="#4e6078">${esc(addrShort(btcAddress))}</text>
    ` : ''}

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
