/**
 * Token metadata API: GET /api/token/:id
 * Returns JSON metadata for marketplaces + the mint page reveal
 */

const TIER_NAMES = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];
const TIER_SYMBOLS = ['🔱', '◈', '◇', '○', '●'];
const COLOR_NAMES = [
  'Azure', 'Amethyst', 'Fuchsia', 'Crimson', 'Amber', 'Jade', 'Forest',
  'Teal', 'Prism', 'Cobalt', 'Chartreuse', 'Violet', 'Gold', 'Pearl',
  'Sepia', 'Shadow', 'Negative', 'Thermal', 'X-Ray', 'Aurora', 'Psychedelic'
];

// Which contract to query (test or production)
const CONTRACTS = {
  test: {
    address: 'SP3JR7JXFT7ZM9JKSQPBQG1HPT0D365MA5TN0P12E',
    name: 'early-eagles-test-v0',
    api: 'https://api.hiro.so',
  },
  production: {
    address: 'SP3JR7JXFT7ZM9JKSQPBQG1HPT0D365MA5TN0P12E',
    name: 'early-eagles',
    api: 'https://api.hiro.so',
  },
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60');

  const tokenId = parseInt(req.query.id);
  if (isNaN(tokenId) || tokenId < 0 || tokenId > 210) {
    return res.status(400).json({ error: 'Invalid token ID' });
  }

  // Try test contract first, fall back to production
  const env = process.env.CONTRACT_MODE || 'test';
  const contract = CONTRACTS[env] || CONTRACTS.test;

  try {
    // Call get-traits on-chain
    const tokenIdHex = '0100000000000000000000000000000' + tokenId.toString(16).padStart(3, '0');
    const callRes = await fetch(
      `${contract.api}/v2/contracts/call-read/${contract.address}/${contract.name}/get-traits`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: contract.address,
          arguments: ['0x' + tokenIdHex],
        }),
      }
    );
    const data = await callRes.json();

    if (!data.okay || data.result === '0x09') {
      return res.status(404).json({ error: 'Token not minted yet' });
    }

    // Parse Clarity tuple response
    // For now return basic metadata; full Clarity decode TBD
    const traits = parseClarityTraits(data.result, tokenId);

    return res.status(200).json({
      name: `Early Eagle #${tokenId}`,
      description: `${TIER_SYMBOLS[traits.tier]} ${TIER_NAMES[traits.tier]} ${COLOR_NAMES[traits.colorId]} Eagle - Genesis AIBTC Agent NFT`,
      image: `https://early-eagles.vercel.app/api/render/${tokenId}`,
      attributes: [
        { trait_type: 'Tier', value: TIER_NAMES[traits.tier] },
        { trait_type: 'Color', value: COLOR_NAMES[traits.colorId] },
        { trait_type: 'Agent ID', value: traits.agentId },
        { trait_type: 'Display Name', value: traits.displayName },
        { trait_type: 'Minted At Block', value: traits.mintedAt },
      ],
      properties: {
        tier: traits.tier,
        color_id: traits.colorId,
        tier_name: TIER_NAMES[traits.tier],
        color_name: COLOR_NAMES[traits.colorId],
        agent_id: traits.agentId,
        btc_address: traits.btcAddress,
        collection: 'Early Eagles',
        total_supply: 210,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch token data: ' + e.message });
  }
};

// Simplified Clarity tuple parser
// Real implementation would use @stacks/transactions ClarityValue decoder
function parseClarityTraits(hex, tokenId) {
  // Fallback: return placeholder if we can't decode
  // Will be replaced with proper decoder
  return {
    tier: 0,
    colorId: 0,
    agentId: tokenId,
    displayName: 'Eagle #' + tokenId,
    btcAddress: '',
    mintedAt: 0,
  };
}
