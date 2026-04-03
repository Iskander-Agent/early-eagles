/**
 * Test Token metadata API: GET /api/test-token/:id
 * Reads REAL on-chain traits (name, BTC addr, sigil, tier, color)
 * but uses placeholder art (no real eagle revealed).
 *
 * This lets us verify the full pipeline:
 *   authorize → contract storage → metadata read → rendering
 */

const TIER_NAMES = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];
const COLOR_NAMES = [
  'Azure', 'Amethyst', 'Fuchsia', 'Crimson', 'Amber', 'Jade', 'Forest',
  'Teal', 'Prism', 'Cobalt', 'Chartreuse', 'Violet', 'Gold', 'Pearl',
  'Sepia', 'Shadow', 'Negative', 'Thermal', 'X-Ray', 'Aurora', 'Psychedelic'
];

const CONTRACT = {
  address: 'SP3JR7JXFT7ZM9JKSQPBQG1HPT0D365MA5TN0P12E',
  name: 'early-eagles-test-v2',
  api: 'https://api.hiro.so',
};

// Decode Clarity value from hex — just enough to extract our trait tuple
function decodeClarityValue(hex) {
  // Remove 0x prefix
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const buf = Buffer.from(h, 'hex');
  return parseClarityBuffer(buf, 0);
}

function parseClarityBuffer(buf, offset) {
  const type = buf[offset];
  switch (type) {
    case 0x00: // int128
      return { value: Number(buf.readBigInt64BE(offset + 9)), end: offset + 17 };
    case 0x01: { // uint128
      const hi = buf.readBigUInt64BE(offset + 1);
      const lo = buf.readBigUInt64BE(offset + 9);
      return { value: Number(hi * BigInt(2**64) + lo), end: offset + 17 };
    }
    case 0x02: // buffer
    case 0x0d: { // string-ascii
      const len = buf.readUInt32BE(offset + 1);
      const data = buf.slice(offset + 5, offset + 5 + len);
      return { value: type === 0x02 ? data.toString('hex') : data.toString('ascii'), end: offset + 5 + len };
    }
    case 0x0e: { // string-utf8
      const len = buf.readUInt32BE(offset + 1);
      const data = buf.slice(offset + 5, offset + 5 + len);
      return { value: data.toString('utf8'), end: offset + 5 + len };
    }
    case 0x05: { // standard principal
      return { value: 'principal', end: offset + 22 };
    }
    case 0x09: // none
      return { value: null, end: offset + 1 };
    case 0x0a: { // some
      const inner = parseClarityBuffer(buf, offset + 1);
      return { value: inner.value, end: inner.end };
    }
    case 0x07: { // ok
      const inner = parseClarityBuffer(buf, offset + 1);
      return { value: inner.value, end: inner.end };
    }
    case 0x08: { // err
      const inner = parseClarityBuffer(buf, offset + 1);
      return { value: { err: inner.value }, end: inner.end };
    }
    case 0x0c: { // tuple
      const numFields = buf.readUInt32BE(offset + 1);
      let pos = offset + 5;
      const obj = {};
      for (let i = 0; i < numFields; i++) {
        // key: 1-byte name-len, then ASCII name
        const nameLen = buf[pos];
        pos++;
        const name = buf.slice(pos, pos + nameLen).toString('ascii');
        pos += nameLen;
        const field = parseClarityBuffer(buf, pos);
        obj[name] = field.value;
        pos = field.end;
      }
      return { value: obj, end: pos };
    }
    default:
      return { value: `unknown_type_${type}`, end: offset + 1 };
  }
}

// Generate placeholder SVG that shows real agent data
function placeholderSvg(tokenId, traits) {
  const tierName = TIER_NAMES[traits.tier] || 'Unknown';
  const colorName = COLOR_NAMES[traits['color-id']] || `Color-${traits['color-id']}`;
  const name = traits['display-name'] || `Agent #${tokenId}`;
  const btcAddr = traits['btc-address'] || '???';
  const shortBtc = btcAddr.length > 16 ? btcAddr.slice(0, 8) + '...' + btcAddr.slice(-6) : btcAddr;
  const sigilHex = traits['sigil-seed'] || '00'.repeat(16);

  // Draw a simple sigil from the seed bytes — 8 points on a circle connected by seed bytes
  const sigilBytes = [];
  for (let i = 0; i < sigilHex.length; i += 2) {
    sigilBytes.push(parseInt(sigilHex.slice(i, i + 2), 16));
  }
  const cx = 170, cy = 360, r = 35;
  const points = [];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2 - Math.PI / 2;
    points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  let sigilPath = '';
  for (let i = 0; i < sigilBytes.length && i < 16; i++) {
    const from = points[i % 8];
    const to = points[sigilBytes[i] % 8];
    sigilPath += `<line x1="${from.x.toFixed(1)}" y1="${from.y.toFixed(1)}" x2="${to.x.toFixed(1)}" y2="${to.y.toFixed(1)}" stroke="#d4a84b" stroke-width="1" opacity="0.7"/>`;
  }
  // Sigil dots
  let sigilDots = points.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2" fill="#d4a84b"/>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="480" viewBox="0 0 340 480">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0d0d2a"/><stop offset="100%" stop-color="#0a0a16"/></linearGradient></defs>
    <rect width="340" height="480" fill="url(#bg)" rx="16"/>
    <text x="170" y="50" text-anchor="middle" fill="#d4a84b" font-size="48">🦅</text>
    <text x="170" y="85" text-anchor="middle" fill="#d4a84b" font-size="11" font-family="Georgia" font-weight="bold">TEST EAGLE #${tokenId}</text>
    <text x="170" y="115" text-anchor="middle" fill="#aaa" font-size="18" font-family="Georgia">${escapeXml(name)}</text>
    <line x1="40" y1="135" x2="300" y2="135" stroke="#333" stroke-width="0.5"/>
    <text x="40" y="160" fill="#888" font-size="10" font-family="monospace">TIER</text>
    <text x="40" y="175" fill="#fff" font-size="14" font-family="Georgia">${tierName}</text>
    <text x="200" y="160" fill="#888" font-size="10" font-family="monospace">COLOR</text>
    <text x="200" y="175" fill="#fff" font-size="14" font-family="Georgia">${colorName}</text>
    <text x="40" y="210" fill="#888" font-size="10" font-family="monospace">BTC ADDRESS</text>
    <text x="40" y="225" fill="#fff" font-size="11" font-family="monospace">${shortBtc}</text>
    <text x="40" y="260" fill="#888" font-size="10" font-family="monospace">AGENT ID</text>
    <text x="40" y="275" fill="#fff" font-size="14" font-family="Georgia">#${traits['agent-id'] || '?'}</text>
    <text x="170" y="315" text-anchor="middle" fill="#555" font-size="9" font-family="monospace" letter-spacing="2">DNA SIGIL</text>
    ${sigilPath}
    ${sigilDots}
    <text x="170" y="430" text-anchor="middle" fill="#333" font-size="8" font-family="monospace">sigil: ${sigilHex.slice(0, 16)}...</text>
    <rect x="30" y="450" width="280" height="20" rx="4" fill="#111" stroke="#333" stroke-width="0.5"/>
    <text x="170" y="464" text-anchor="middle" fill="#555" font-size="9" font-family="monospace">EARLY EAGLES TEST COLLECTION</text>
  </svg>`;
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=30');

  const tokenId = parseInt(req.query.id);
  if (isNaN(tokenId) || tokenId < 0 || tokenId > 210) {
    return res.status(400).json({ error: 'Invalid token ID' });
  }

  // Encode uint for Clarity call: type 0x01 + 16 bytes big-endian
  const uintBuf = Buffer.alloc(17);
  uintBuf[0] = 0x01;
  uintBuf.writeBigUInt64BE(0n, 1);
  uintBuf.writeBigUInt64BE(BigInt(tokenId), 9);
  const uintHex = uintBuf.toString('hex');

  try {
    const callRes = await fetch(
      `${CONTRACT.api}/v2/contracts/call-read/${CONTRACT.address}/${CONTRACT.name}/get-traits`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: CONTRACT.address,
          arguments: ['0x' + uintHex],
        }),
      }
    );
    const data = await callRes.json();

    if (!data.okay || !data.result || data.result === '0x09') {
      return res.status(404).json({ error: 'Token not minted yet' });
    }

    // Decode the Clarity response
    const decoded = decodeClarityValue(data.result);
    const traits = decoded.value || {};

    const tierName = TIER_NAMES[traits.tier] || 'Unknown';
    const colorName = COLOR_NAMES[traits['color-id']] || `Color-${traits['color-id']}`;
    const displayName = traits['display-name'] || `Agent #${tokenId}`;

    // Generate placeholder SVG with real data
    const svg = placeholderSvg(tokenId, traits);
    const imageUri = `data:image/svg+xml,${encodeURIComponent(svg)}`;

    return res.status(200).json({
      name: `Test Eagle #${tokenId} — ${displayName}`,
      description: `Test collection — Early Eagles Genesis AIBTC Agent NFT. Agent: ${displayName}`,
      image: imageUri,
      attributes: [
        { trait_type: 'Tier', value: tierName },
        { trait_type: 'Color', value: colorName },
        { trait_type: 'Agent Name', value: displayName },
        { trait_type: 'Agent ID', value: traits['agent-id'] },
        { trait_type: 'BTC Address', value: traits['btc-address'] },
        { trait_type: 'Sigil Seed', value: traits['sigil-seed'] },
        { trait_type: 'Minted At Block', value: traits['minted-at'] },
      ],
      properties: {
        collection: 'Early Eagles TEST',
        total_supply: 210,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to read traits: ' + e.message });
  }
};
