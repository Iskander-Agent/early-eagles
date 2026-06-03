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

const { c32address } = require('c32check');
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

function buildBadge({ tokenId, count, tier, agentName, address, profileUrl }) {
  const t = TIERS[tier] ?? TIERS[4];
  const W = 420, H = 80;

  const title  = count > 1
    ? `EARLY EAGLES ×${count}`
    : `EARLY EAGLE #${tokenId}`;
  const line2  = truncate(agentName || abbrev(address), 40);
  const line3  = abbrev(address);

  // Tier pill: sits top-right
  const PILL_W = 76, PILL_X = W - PILL_W - 12;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Early Eagle #${tokenId} — ${t.name} — ${agentName || address}">
  <title>Early Eagle #${tokenId} — ${t.name}${agentName ? ' — ' + agentName : ''}</title>
  <defs>
    <linearGradient id="bg-g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0f1520"/>
      <stop offset="100%" stop-color="#0a0d14"/>
    </linearGradient>
    <clipPath id="r8"><rect width="${W}" height="${H}" rx="8"/></clipPath>
  </defs>

  <!-- Background + border -->
  <rect width="${W}" height="${H}" rx="8" fill="url(#bg-g)"/>
  <rect width="${W}" height="${H}" rx="8" fill="none" stroke="rgba(212,168,75,0.2)" stroke-width="1"/>

  <!-- Left tier accent bar -->
  <rect x="0" y="0" width="4" height="${H}" fill="${t.color}" clip-path="url(#r8)" opacity="0.95"/>

  <!-- Eagle icon box -->
  <rect x="14" y="18" width="38" height="44" rx="7" fill="${t.dim}"/>
  <text x="33" y="46" font-size="22" text-anchor="middle"
        font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,serif">🦅</text>

  <!-- Token title -->
  <text x="64" y="30"
        font-family="Rajdhani,Georgia,sans-serif" font-size="14" font-weight="700"
        fill="#e8eaf0" letter-spacing="0.6">${esc(title)}</text>

  <!-- Agent name / label -->
  <text x="64" y="49"
        font-family="Inter,Arial,sans-serif" font-size="11.5"
        fill="#8892a4">${esc(line2)}</text>

  <!-- Address -->
  <text x="64" y="65"
        font-family="'Courier New',Courier,monospace" font-size="10"
        fill="#4a5568">${esc(line3)}</text>

  <!-- Tier pill -->
  <rect x="${PILL_X}" y="13" width="${PILL_W}" height="22" rx="5" fill="${t.dim}"/>
  <text x="${PILL_X + PILL_W / 2}" y="28.5"
        font-family="Rajdhani,Georgia,sans-serif" font-size="11" font-weight="700"
        fill="${t.text}" text-anchor="middle" letter-spacing="0.5">${esc(t.name.toUpperCase())}</text>

  <!-- Verified pill -->
  <rect x="${PILL_X}" y="44" width="${PILL_W}" height="20" rx="5" fill="rgba(0,255,136,0.08)"/>
  <text x="${PILL_X + PILL_W / 2}" y="58"
        font-family="Inter,Arial,sans-serif" font-size="10"
        fill="#00ff88" text-anchor="middle">✓ On-Chain</text>

  <!-- Clickable overlay -->
  <a href="${esc(profileUrl)}" target="_blank">
    <rect width="${W}" height="${H}" rx="8" fill="transparent"/>
  </a>
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

  const profileUrl = `${BASE_URL}/eagle/${primaryId}`;
  const svg = buildBadge({ tokenId: primaryId, count: tokenIds.length, tier, agentName, address, profileUrl });

  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=600');
  return res.status(200).send(svg);
};
