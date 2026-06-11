/**
 * Early Eagles — GET /api/market
 *
 * Returns all active listings from the on-chain marketplace.
 * Reads get-listing(id) for every minted token, returns only those
 * that have an active listing with price + seller.
 *
 * Response:
 *   { listings: [{ tokenId, price_ustx, price_stx, seller, tier, tierName }],
 *     totalMinted, floorPrice_ustx, floorPrice_stx, builtAt }
 *
 * Cache: 30s CDN, 5min stale-while-revalidate (listings change infrequently)
 */

const { c32address } = require('c32check');
const { fetchCallReadOnlyFunction, cvToValue } = require('@stacks/transactions');
const { STACKS_MAINNET } = require('@stacks/network');

const STACKS_API    = 'https://api.hiro.so';
const ADMIN_ADDRESS = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2';
const NFT_CONTRACT  = 'early-eagles-v2';
const TIER_NAMES    = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];
const TIER_IDS      = ['legendary', 'epic', 'rare', 'uncommon', 'common'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function abort(ms) { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; }

function encodeUint(n) {
  return '0x01' + n.toString(16).padStart(32, '0');
}

// Decode (optional (tuple (price uint) (seller principal))) hex
function decodeListing(hexResult) {
  try {
    let hex = (hexResult || '').replace('0x', '');
    if (hex === '09') return null; // none
    if (!hex.startsWith('0a')) return null; // not optional-some
    hex = hex.slice(2); // strip optional-some

    // Now a tuple: 0c <num-fields:4> <fields...>
    if (!hex.startsWith('0c')) return null;
    hex = hex.slice(2);
    const numFields = parseInt(hex.slice(0, 8), 16);
    hex = hex.slice(8);

    const fields = {};
    for (let i = 0; i < numFields; i++) {
      // Field name: 2-byte length + ascii bytes
      const nameLen = parseInt(hex.slice(0, 4), 16);
      hex = hex.slice(4);
      const nameHex = hex.slice(0, nameLen * 2);
      hex = hex.slice(nameLen * 2);
      const name = nameHex.match(/.{2}/g).map(b => String.fromCharCode(parseInt(b, 16))).join('');

      // Field value: type tag + data
      const tag = hex.slice(0, 2);
      hex = hex.slice(2);
      if (tag === '01') {
        // uint128: 16 bytes
        const val = BigInt('0x' + hex.slice(0, 32));
        hex = hex.slice(32);
        fields[name] = val;
      } else if (tag === '05') {
        // standard principal: 1-byte version + 20-byte hash
        const version = parseInt(hex.slice(0, 2), 16);
        const hashHex = hex.slice(2, 42);
        hex = hex.slice(42);
        try { fields[name] = c32address(version, hashHex); } catch { fields[name] = null; }
      } else {
        // Unknown type — skip (can't decode length without knowing type)
        return null;
      }
    }

    const price = fields['price'] ?? fields['list-price'];
    const seller = fields['seller'];
    if (price == null || !seller) return null;
    return { price_ustx: price, seller };
  } catch { return null; }
}

async function callRead(fn, args = [], retries = 3) {
  const url = `${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDRESS}/${NFT_CONTRACT}/${fn}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: ADMIN_ADDRESS, arguments: args }),
        signal: abort(7000),
      });
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 2000 + attempt * 2000));
        continue;
      }
      if (!res.ok) throw new Error(`callRead ${fn} → ${res.status}`);
      return res.json();
    } catch (e) {
      if (attempt < retries) { await new Promise(r => setTimeout(r, 1500 + attempt * 1500)); continue; }
      throw e;
    }
  }
}

// In-memory cache (warm Vercel invocations)
let _cache = { listings: [], totalMinted: 0, tierStats: null, builtAt: 0 };
const CACHE_TTL = 30_000; // 30s — match CDN header

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=300');

  // Serve warm cache if fresh enough
  if (Date.now() - _cache.builtAt < CACHE_TTL && _cache.totalMinted > 0) {
    return res.status(200).json({ ..._cache, stale: false });
  }

  try {
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

    // Extract per-tier remaining (same call, no extra invocation)
    const parseStat = (key) => parseInt(stats[key]?.value ?? stats[key] ?? '0', 10) || 0;
    const TIER_CAPS = { legendary: 7, epic: 63, rare: 84, uncommon: 140, common: 126 };
    const tierStats = {
      legendary: { remaining: parseStat('legendary-remaining'), cap: TIER_CAPS.legendary },
      epic:      { remaining: parseStat('epic-remaining'),      cap: TIER_CAPS.epic },
      rare:      { remaining: parseStat('rare-remaining'),      cap: TIER_CAPS.rare },
      uncommon:  { remaining: parseStat('uncommon-remaining'),  cap: TIER_CAPS.uncommon },
      common:    { remaining: parseStat('common-remaining'),    cap: TIER_CAPS.common },
    };

    // 2. Fan-out get-listing calls (batches of 8 with small delay)
    const ids = Array.from({ length: totalMinted }, (_, i) => i);
    const listings = [];

    for (let batch = 0; batch < ids.length; batch += 8) {
      const chunk = ids.slice(batch, batch + 8);
      const results = await Promise.allSettled(
        chunk.map(async id => {
          const d = await callRead('get-listing', [encodeUint(id)]);
          if (!d?.okay) return null;
          const listing = decodeListing(d.result);
          if (!listing) return null;
          return { tokenId: id, ...listing };
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) listings.push(r.value);
      }
      if (batch + 8 < ids.length) await new Promise(r => setTimeout(r, 250));
    }

    // 3. Enrich with token metadata for each listing
    const enriched = await Promise.allSettled(
      listings.map(async l => {
        try {
          const metaRes = await fetch(
            `https://early-eagles.vercel.app/api/token/${l.tokenId}`,
            { signal: abort(6000) }
          );
          if (!metaRes.ok) return { ...l, tier: 4, tierName: 'Common', tierId: 'common', displayName: `Eagle #${l.tokenId}` };
          const meta = await metaRes.json();
          const props = meta.properties || {};
          return {
            ...l,
            tier:        props.tier ?? 4,
            tierName:    props.tier_name || TIER_NAMES[props.tier ?? 4] || 'Common',
            tierId:      TIER_IDS[props.tier ?? 4] || 'common',
            colorName:   props.color_name || '',
            displayName: props.display_name || `Eagle #${l.tokenId}`,
            price_stx:   Number(l.price_ustx) / 1_000_000,
          };
        } catch {
          return { ...l, tier: 4, tierName: 'Common', tierId: 'common', displayName: `Eagle #${l.tokenId}`, price_stx: Number(l.price_ustx) / 1_000_000 };
        }
      })
    );

    const finalListings = enriched
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => ({ ...r.value, price_ustx: String(r.value.price_ustx), price_stx: r.value.price_stx }))
      .sort((a, b) => Number(a.price_ustx) - Number(b.price_ustx)); // floor first

    const floorPrice_ustx = finalListings.length > 0 ? finalListings[0].price_ustx : null;
    const floorPrice_stx  = floorPrice_ustx ? Number(floorPrice_ustx) / 1_000_000 : null;

    _cache = { listings: finalListings, totalMinted, tierStats, floorPrice_ustx, floorPrice_stx, builtAt: Date.now() };

    return res.status(200).json({
      listings: finalListings,
      totalMinted,
      tierStats,
      floorPrice_ustx,
      floorPrice_stx,
      builtAt: new Date().toISOString(),
    });

  } catch (e) {
    console.error('Market API error:', e.message);
    if (_cache.totalMinted > 0) {
      return res.status(200).json({ ..._cache, stale: true });
    }
    return res.status(503).json({ error: 'Market data temporarily unavailable', detail: e.message });
  }
};
