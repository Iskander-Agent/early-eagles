/**
 * Test Token metadata API: GET /api/test-token/:id
 * Returns placeholder metadata (no real art or names revealed)
 */

const TIER_NAMES = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];
const COLOR_NAMES = [
  'Color-A', 'Color-B', 'Color-C', 'Color-D', 'Color-E', 'Color-F', 'Color-G',
  'Color-H', 'Color-I', 'Color-J', 'Color-K', 'Color-L', 'Color-M', 'Color-N',
  'Color-O', 'Color-P', 'Color-Q', 'Color-R', 'Color-S', 'Color-T', 'Color-U'
];

const CONTRACT = {
  address: 'SP3JR7JXFT7ZM9JKSQPBQG1HPT0D365MA5TN0P12E',
  name: 'early-eagles-test-v0',
  api: 'https://api.hiro.so',
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=30');

  const tokenId = parseInt(req.query.id);
  if (isNaN(tokenId) || tokenId < 0 || tokenId > 210) {
    return res.status(400).json({ error: 'Invalid token ID' });
  }

  // Placeholder image (simple SVG)
  const placeholderImage = `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="480" viewBox="0 0 340 480">
      <rect width="340" height="480" fill="#0d0d1a" rx="16"/>
      <text x="170" y="200" text-anchor="middle" fill="#d4a84b" font-size="72">🦅</text>
      <text x="170" y="260" text-anchor="middle" fill="#555568" font-size="14" font-family="Georgia">TEST EAGLE #${tokenId}</text>
      <text x="170" y="290" text-anchor="middle" fill="#333" font-size="11" font-family="Georgia">Early Eagles Test Collection</text>
    </svg>`
  )}`;

  // Try to read traits from contract
  try {
    const uintHex = '0100000000000000000000000000000' + tokenId.toString(16).padStart(3, '0');
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

    if (!data.okay || data.result === '0x09') {
      return res.status(404).json({ error: 'Token not minted yet' });
    }

    // Return placeholder metadata
    return res.status(200).json({
      name: `Test Eagle #${tokenId}`,
      description: `Test collection — Early Eagles Genesis AIBTC Agent NFT`,
      image: placeholderImage,
      attributes: [
        { trait_type: 'Collection', value: 'Early Eagles TEST' },
        { trait_type: 'Token ID', value: tokenId },
      ],
      properties: {
        collection: 'Early Eagles TEST',
        total_supply: 210,
        note: 'This is a test token. Real art and traits will be on the production contract.',
      },
    });
  } catch (e) {
    // If contract not deployed yet, return basic placeholder
    return res.status(200).json({
      name: `Test Eagle #${tokenId}`,
      description: 'Test collection — Early Eagles Genesis AIBTC Agent NFT',
      image: placeholderImage,
      properties: { collection: 'Early Eagles TEST', note: 'Contract not yet deployed' },
    });
  }
};
