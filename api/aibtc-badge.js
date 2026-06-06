/**
 * Early Eagles — /api/aibtc-badge → AIBTC agent identity badge
 *
 * GET /api/aibtc-badge?address=SP...
 * GET /api/aibtc-badge/SP...  (via vercel.json rewrite)
 *
 * Hard gate: agent must have an ERC-8004 registration and Genesis level ≥ 2.
 * Data source: https://aibtc.com/api/agents/{address}
 *
 * Returns an SVG badge. Embed anywhere:
 *   ![AIBTC Agent](https://early-eagles.vercel.app/api/aibtc-badge/SP_YOUR_ADDRESS)
 */

const AIBTC_API          = 'https://aibtc.com/api';
const AIBTC_PROFILE_BASE = 'https://aibtc.com/agents';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

function abort(ms) { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; }

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function abbrev(addr) {
  if (!addr || addr.length < 14) return addr;
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function buildBadge({ agentId, displayName, bnsName, levelName, stxAddress, btcAddress, profileUrl }) {
  const W = 340, H = 64;
  // uid must be a valid JS identifier prefix — ab + numeric id is always safe
  const uid = `ab${agentId}`;

  const title = `AIBTC AGENT #${agentId}`;
  const nameBase = displayName || abbrev(stxAddress);
  const sub = truncate(bnsName ? `${bnsName} · ${nameBase}` : nameBase, 64);
  const levelLabel = (levelName || 'Agent').toUpperCase();

  const PILL_W = 72, PILL_H = 16;
  const PILL_X = W - PILL_W - 8;
  const PILL_CX = PILL_X + PILL_W / 2;
  const HDR = 45;
  const ADDR_Y = HDR + 14;

  const copyIcon = (ix, iy, confirmId, val) => `
    <g onclick="${uid}cp('${confirmId}','${val}')" style="cursor:pointer">
      <rect x="${ix}"   y="${iy + 2}" width="5" height="5" rx="0.8"
            fill="#0d0514" stroke="rgba(255,255,255,0.18)" stroke-width="0.6"/>
      <rect x="${ix + 2}" y="${iy}"   width="5" height="5" rx="0.8"
            fill="#0d0514" stroke="rgba(255,255,255,0.32)" stroke-width="0.6"/>
      <text id="${confirmId}" x="${ix + 4.5}" y="${iy + 5.5}"
            font-family="-apple-system,BlinkMacSystemFont,sans-serif"
            font-size="5.5" font-weight="700" fill="#00c97a" text-anchor="middle"></text>
    </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
     role="img" aria-label="${esc(title)} — ${esc(nameBase)}">
  <title>${esc(title)} — ${esc(nameBase)} · ${esc(levelName)}</title>
  <defs>
    <linearGradient id="${uid}bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#0d0514"/>
      <stop offset="100%" stop-color="#08020e"/>
    </linearGradient>
    <linearGradient id="${uid}bar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#f7931a"/>
      <stop offset="100%" stop-color="#f7931a" stop-opacity="0.35"/>
    </linearGradient>
    <radialGradient id="${uid}glow" cx="0%" cy="0%" r="60%">
      <stop offset="0%"   stop-color="#f7931a" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#f7931a" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="${uid}cl"><rect width="${W}" height="${H}" rx="10"/></clipPath>
  </defs>

  <script type="text/javascript"><![CDATA[
    function ${uid}cp(id,v){if(!navigator.clipboard)return;navigator.clipboard.writeText(v).then(function(){var e=document.getElementById(id);if(!e)return;e.textContent='✓';setTimeout(function(){e.textContent='';},1600);});}
  ]]></script>

  <g clip-path="url(#${uid}cl)">
    <rect width="${W}" height="${H}" fill="url(#${uid}bg)"/>
    <rect width="${W}" height="${H}" fill="url(#${uid}glow)"/>
    <rect x="0" y="0" width="4" height="${H}" fill="url(#${uid}bar)"/>
    <rect width="${W}" height="${H}" rx="10" fill="none"
          stroke="rgba(247,147,26,0.15)" stroke-width="0.8"/>

    <line x1="4" y1="${HDR}" x2="${W}" y2="${HDR}"
          stroke="rgba(255,255,255,0.08)" stroke-width="0.6"/>

    <!-- Row A: icon · title LEFT  |  level pill RIGHT -->
    <rect x="12" y="7" width="18" height="18" rx="4" fill="rgba(247,147,26,0.15)"/>
    <text x="21" y="20" font-size="11" text-anchor="middle"
          font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,serif">🤖</text>

    <text x="36" y="21"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="11" font-weight="700" fill="#eef3ff" letter-spacing="0.2">${esc(title)}</text>

    <rect x="${PILL_X}" y="7" width="${PILL_W}" height="${PILL_H}" rx="5"
          fill="rgba(247,147,26,0.15)" stroke="#f7931a" stroke-width="0.6" stroke-opacity="0.5"/>
    <text x="${PILL_CX}" y="${7 + PILL_H / 2 + 3}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7.5" font-weight="800" fill="#f7931a" text-anchor="middle"
          letter-spacing="1.2">${esc(levelLabel)}</text>

    <!-- Row B: name LEFT  |  ✓ on-chain · View Profile → RIGHT -->
    <text x="36" y="37"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="10" font-weight="500" fill="#8ba4c4">${esc(sub)}</text>

    <text x="${W - 82}" y="37" text-anchor="end"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7.5" fill="rgba(125,162,255,0.85)">✓ on-chain</text>

    <a href="${esc(profileUrl)}" target="_blank">
      <text x="${W - 8}" y="37"
            font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
            font-size="8" fill="#f7931a" text-anchor="end" opacity="0.9">View Profile →</text>
    </a>

    <!-- Address row: STX left · BTC right -->
    <text x="51" y="${ADDR_Y}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7" font-weight="700" letter-spacing="0.6" fill="#f7931a">STX</text>
    <text x="69" y="${ADDR_Y}"
          font-family="'SF Mono','Fira Code','Consolas',monospace"
          font-size="9" fill="#8899b4">${esc(abbrev(stxAddress))}</text>
    ${copyIcon(153, HDR + 7, `${uid}sc`, stxAddress)}

    ${btcAddress ? `
    <text x="180" y="${ADDR_Y}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7" font-weight="700" letter-spacing="0.6" fill="#f7931a">BTC</text>
    <text x="198" y="${ADDR_Y}"
          font-family="'SF Mono','Fira Code','Consolas',monospace"
          font-size="9" fill="#8899b4">${esc(abbrev(btcAddress))}</text>
    ${copyIcon(282, HDR + 7, `${uid}bc`, btcAddress)}
    ` : ''}
  </g>
</svg>`;
}

function errorSVG(message, status) {
  const color = status === 404 || status === 403 ? '#4a5568' : '#ff4d6a';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="280" height="40" viewBox="0 0 280 40">
  <rect width="280" height="40" rx="6" fill="#050208" stroke="rgba(247,147,26,0.15)" stroke-width="1"/>
  <text x="140" y="25" font-family="Inter,Arial,sans-serif" font-size="12"
        fill="${color}" text-anchor="middle">${esc(message)}</text>
</svg>`;
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Content-Type', 'image/svg+xml');

  if (req.method === 'OPTIONS') return res.status(204).end();

  let address = String((req.query || {}).address || '').trim();

  if (!address) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).send(errorSVG('Missing ?address= parameter', 400));
  }

  if (address.startsWith('ST')) address = 'SP' + address.slice(2);

  if (!/^S[PM][A-Z0-9]{38,41}$/.test(address)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).send(errorSVG('Invalid Stacks address', 400));
  }

  let agentData;
  try {
    const r = await fetch(`${AIBTC_API}/agents/${address}`, { signal: abort(8000) });
    if (!r.ok) throw new Error(`AIBTC API → ${r.status}`);
    agentData = await r.json();
  } catch {
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.status(503).send(errorSVG('Service unavailable — try again', 503));
  }

  if (!agentData.found) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(404).send(errorSVG('AIBTC agent not found', 404));
  }

  const { agent, level, levelName } = agentData;

  if (!agent.erc8004AgentId || level < 2) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(403).send(errorSVG('Genesis 2+ required', 403));
  }

  const svg = buildBadge({
    agentId:     agent.erc8004AgentId,
    displayName: agent.displayName || null,
    bnsName:     agent.bnsName || null,
    levelName,
    stxAddress:  agent.stxAddress,
    btcAddress:  agent.btcAddress || null,
    profileUrl:  `${AIBTC_PROFILE_BASE}/${address}`,
  });

  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=600');
  return res.status(200).send(svg);
};
