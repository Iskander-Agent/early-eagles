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

function relativeTime(iso) {
  if (!iso) return null;
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3600000);
  if (h < 1) return 'active now';
  if (h < 24) return `active ${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'active yesterday' : `active ${d}d ago`;
}

function buildBadge({ agentId, displayName, bnsName, level, levelName, stxAddress, btcAddress, profileUrl }) {
  const W = 340, H = 64;
  // uid must be a valid JS identifier prefix — ab + numeric id is always safe
  const uid = `ab${agentId}`;

  const title = `AIBTC AGENT #${agentId}`;
  const nameBase = displayName || abbrev(stxAddress);
  const sub = truncate(bnsName ? `${bnsName} · ${nameBase}` : nameBase, 64);
  const levelLabel = `${(levelName || 'Agent').toUpperCase()} ${level}`;

  const PILL_W = 82, PILL_H = 16;
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

// ── Pill (compact, dynamic width) ────────────────────────────────────────────
// Two-section design: [🤖 AIBTC | #id · name · GENESIS N ✓]
// Width auto-fits content — no dead space.

function buildPillBadge({ agentId, level, levelName, displayName, bnsName, profileUrl }) {
  const H = 24, LEFT_W = 58;
  const name      = truncate(bnsName || displayName || '', 12) || null;
  const levelText = `${(levelName || 'Agent').toUpperCase()} ${level}`;

  // Approximate char widths at their respective font sizes
  const idW  = 8 + String(agentId).length * 5.4;       // '#xxx'
  const nmW  = name ? 8 + name.length * 4.8 + 8 : 0;   // '· name '
  const lvlW = levelText.length * 4.5 + 6;             // 'GENESIS 2'
  const rightW = Math.max(88, Math.ceil(8 + idW + nmW + lvlW + 14 + 6));
  const W = LEFT_W + rightW;

  // Right section x anchors
  const RX    = LEFT_W + 8;           // #agentId starts here
  const nmX   = RX + Math.ceil(idW);  // name starts after agentId
  const lvlX  = W - 14;              // levelText ends here (text-anchor end)
  const chkX  = W - 4;               // ✓ ends here (text-anchor end)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
     role="img" aria-label="AIBTC Agent #${agentId}">
  <title>AIBTC Agent #${agentId} · ${esc(levelText)}</title>
  <defs><clipPath id="pcl"><rect width="${W}" height="${H}" rx="12"/></clipPath></defs>
  <g clip-path="url(#pcl)">
    <!-- Left label section -->
    <rect x="0" y="0" width="${LEFT_W}" height="${H}" fill="#090214"/>
    <!-- Right value section -->
    <rect x="${LEFT_W}" y="0" width="${rightW}" height="${H}" fill="#0d0514"/>
    <!-- Outer border -->
    <rect width="${W}" height="${H}" rx="12" fill="none"
          stroke="rgba(247,147,26,0.28)" stroke-width="0.8"/>
    <!-- Section divider -->
    <line x1="${LEFT_W}" y1="5" x2="${LEFT_W}" y2="${H - 5}"
          stroke="rgba(247,147,26,0.20)" stroke-width="0.6"/>

    <!-- Left: 🤖 AIBTC -->
    <text x="9" y="15.5"
          font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,serif"
          font-size="9">🤖</text>
    <text x="21" y="15.5"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7.5" font-weight="700" fill="rgba(255,255,255,0.45)">AIBTC</text>

    <!-- Right: #agentId -->
    <text x="${RX}" y="15.5"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="9" font-weight="800" fill="#f7931a">#${esc(String(agentId))}</text>

    ${name ? `
    <!-- Right: name -->
    <text x="${nmX}" y="15.5"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7.5" fill="rgba(255,255,255,0.25)">·</text>
    <text x="${nmX + 8}" y="15.5"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7.5" fill="#8ba4c4">${esc(name)}</text>
    ` : ''}

    <!-- Right: level · ✓ (right-aligned, never collide with left content) -->
    <text x="${lvlX}" y="15.5"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7" font-weight="700" fill="#f7931a" text-anchor="end"
          letter-spacing="0.5">${esc(levelText)}</text>
    <a href="${esc(profileUrl)}" target="_blank">
      <text x="${chkX}" y="15.5"
            font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
            font-size="7.5" fill="rgba(125,162,255,0.85)" text-anchor="end">✓</text>
    </a>
  </g>
</svg>`;
}

// ── Capability card (380×92) ─────────────────────────────────────────────────

const CAP_META = {
  heartbeat: { label: 'HEARTBEAT', color: '#00c97a',           dim: 'rgba(0,201,122,0.15)'    },
  inbox:     { label: 'INBOX',     color: 'rgba(125,162,255,0.9)', dim: 'rgba(125,162,255,0.12)' },
  x402:      { label: 'X402',      color: '#f7931a',           dim: 'rgba(247,147,26,0.15)'   },
};

function buildCapCard({ agentId, displayName, bnsName, level, levelName, stxAddress, btcAddress, capabilities, lastActiveAt, profileUrl }) {
  const W = 380, H = 92;
  const uid = `cc${agentId}`;

  const title = `AIBTC AGENT #${agentId}`;
  const nameBase = displayName || abbrev(stxAddress);
  const sub = truncate(bnsName ? `${bnsName} · ${nameBase}` : nameBase, 72);
  const levelLabel = `${(levelName || 'Agent').toUpperCase()} ${level}`;

  const PILL_W = 82, PILL_H = 16;
  const PILL_X = W - PILL_W - 8;
  const PILL_CX = PILL_X + PILL_W / 2;
  const HDR = 45;
  const ADDR_Y = HDR + 14;
  const CAP_Y = 66;        // top of capability section
  const CAP_MID = CAP_Y + 13; // chip vertical center
  const CAP_H = 13;

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

  // Build capability chips left-aligned from x=12
  const caps = (capabilities || []).filter(c => CAP_META[c]);
  const CHIP_PAD = 10, CHIP_GAP = 6;
  // Estimate chip widths: ~5.2px per char at font-size 6.5 + padding
  const chipWidths = { HEARTBEAT: 54, INBOX: 32, X402: 27 };
  let chipX = 12;
  const chipSVG = caps.map(c => {
    const m = CAP_META[c];
    const cw = chipWidths[m.label] || (m.label.length * 5.2 + CHIP_PAD * 2);
    const cx = chipX + cw / 2;
    const out = `
    <rect x="${chipX}" y="${CAP_MID - CAP_H / 2}" width="${cw}" height="${CAP_H}" rx="4"
          fill="${m.dim}" stroke="${m.color}" stroke-width="0.5" stroke-opacity="0.6"/>
    <text x="${cx}" y="${CAP_MID + 2.5}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="6.5" font-weight="700" fill="${m.color}" text-anchor="middle"
          letter-spacing="0.8">${m.label}</text>`;
    chipX += cw + CHIP_GAP;
    return out;
  }).join('');

  const lastActive = relativeTime(lastActiveAt);

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

    <!-- Row A/B divider -->
    <line x1="4" y1="${HDR}" x2="${W}" y2="${HDR}"
          stroke="rgba(255,255,255,0.08)" stroke-width="0.6"/>

    <!-- Row A: icon · title · level pill -->
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

    <!-- Row B: name · verified · profile link -->
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

    <!-- Address row -->
    <text x="51" y="${ADDR_Y}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7" font-weight="700" letter-spacing="0.6" fill="#f7931a">STX</text>
    <text x="69" y="${ADDR_Y}"
          font-family="'SF Mono','Fira Code','Consolas',monospace"
          font-size="9" fill="#8899b4">${esc(abbrev(stxAddress))}</text>
    ${copyIcon(153, HDR + 7, `${uid}sc`, stxAddress)}
    ${btcAddress ? `
    <text x="196" y="${ADDR_Y}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7" font-weight="700" letter-spacing="0.6" fill="#f7931a">BTC</text>
    <text x="214" y="${ADDR_Y}"
          font-family="'SF Mono','Fira Code','Consolas',monospace"
          font-size="9" fill="#8899b4">${esc(abbrev(btcAddress))}</text>
    ${copyIcon(298, HDR + 7, `${uid}bc`, btcAddress)}
    ` : ''}

    <!-- Capability section divider -->
    <line x1="4" y1="${CAP_Y}" x2="${W}" y2="${CAP_Y}"
          stroke="rgba(255,255,255,0.06)" stroke-width="0.6"/>

    <!-- Capability chips -->
    ${chipSVG}

    <!-- Last active (right-aligned) -->
    ${lastActive ? `
    <text x="${W - 8}" y="${CAP_MID + 2.5}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7" fill="rgba(255,255,255,0.25)" text-anchor="end">${esc(lastActive)}</text>
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

  const { agent, level, levelName, capabilities } = agentData;

  if (!agent.erc8004AgentId || level < 2) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(403).send(errorSVG('Genesis 2+ required', 403));
  }

  const style      = String((req.query || {}).style || 'standard').trim();
  const profileUrl = `${AIBTC_PROFILE_BASE}/${address}`;
  const shared     = {
    agentId:     agent.erc8004AgentId,
    level,
    levelName,
    profileUrl,
  };

  let svg;
  if (style === 'pill') {
    svg = buildPillBadge({
      ...shared,
      displayName: agent.displayName || null,
      bnsName:     agent.bnsName || null,
    });
  } else if (style === 'card') {
    svg = buildCapCard({
      ...shared,
      displayName:  agent.displayName || null,
      bnsName:      agent.bnsName || null,
      stxAddress:   agent.stxAddress,
      btcAddress:   agent.btcAddress || null,
      capabilities: capabilities || [],
      lastActiveAt: agent.lastActiveAt || null,
    });
  } else {
    svg = buildBadge({
      ...shared,
      displayName: agent.displayName || null,
      bnsName:     agent.bnsName || null,
      stxAddress:  agent.stxAddress,
      btcAddress:  agent.btcAddress || null,
    });
  }

  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=600');
  return res.status(200).send(svg);
};
