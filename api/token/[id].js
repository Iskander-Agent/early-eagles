/**
 * Token metadata API: GET /api/token/:id
 * Returns JSON metadata for marketplaces + the mint page reveal
 */

const TIER_NAMES = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];
const TIER_SYMBOLS = ['🔱', '◈', '◇', '○', '●'];
const COLOR_NAMES = [
  'Azure', 'Sapphire', 'Amethyst', 'Fuchsia', 'Crimson', 'Scarlet', 'Ember',
  'Amber', 'Chartreuse', 'Jade', 'Forest', 'Teal',
  'Gold', 'Pearl', 'Negative', 'Thermal', 'X-Ray', 'Aurora', 'Psychedelic', 'Bitcoin', 'Shadow'
];

// Hardcoded - the contract identity is not a runtime config.
const ADMIN_ADDRESS = 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2';
const NFT_CONTRACT = 'early-eagles-v2';
const STACKS_API = 'https://api.hiro.so';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'https://early-eagles.vercel.app');
  res.setHeader('Cache-Control', 'public, max-age=60');

  const tokenId = parseInt(req.query.id);
  if (isNaN(tokenId) || tokenId < 0 || tokenId > 420) {
    return res.status(400).json({ error: 'Invalid token ID' });
  }

  try {
    const { cvToJSON, hexToCV } = await import('@stacks/transactions');

    // Encode token-id as Clarity uint
    const tokenIdHex = '0x01' + tokenId.toString(16).padStart(32, '0');
    const callRes = await fetch(
      `${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDRESS}/${NFT_CONTRACT}/get-traits`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: ADMIN_ADDRESS,
          arguments: [tokenIdHex],
        }),
      }
    );
    const data = await callRes.json();

    if (!data.okay || data.result === '0x09') {
      return res.status(404).json({ error: 'Token not minted yet' });
    }

    // Decode Clarity optional tuple using @stacks/transactions
    const cv = hexToCV(data.result);
    const json = cvToJSON(cv);

    // (optional (tuple ...)) — cvToJSON wraps twice: outer optional + inner
    // tuple. To get to the field map we unwrap both .value layers.
    if (!json || json.type === 'none' || !json.value || !json.value.value) {
      return res.status(404).json({ error: 'Token not minted yet' });
    }
    const traits = json.value.value;

    const tier = parseInt(traits.tier?.value ?? '0', 10);
    const colorId = parseInt(traits['color-id']?.value ?? '0', 10);
    const agentId = parseInt(traits['agent-id']?.value ?? '0', 10);
    const displayName = traits['display-name']?.value ?? 'Eagle #' + tokenId;
    const nameAscii = traits['name-ascii']?.value ?? '';
    const btcAddress = traits['btc-address']?.value ?? '';
    const mintedAt = parseInt(traits['minted-at']?.value ?? '0', 10);

    return res.status(200).json({
      name: `Early Eagle #${tokenId}`,
      description: `${TIER_SYMBOLS[tier] || '●'} ${TIER_NAMES[tier] || 'Common'} ${COLOR_NAMES[colorId] || 'Unknown'} Eagle - Genesis AIBTC Agent NFT`,
      attributes: [
        { trait_type: 'Tier', value: TIER_NAMES[tier] || 'Common' },
        { trait_type: 'Color', value: COLOR_NAMES[colorId] || 'Unknown' },
        { trait_type: 'Agent ID', value: agentId },
        { trait_type: 'Display Name', value: displayName },
        { trait_type: 'Name', value: nameAscii },
        { trait_type: 'Minted At Block', value: mintedAt },
      ],
      properties: {
        tier,
        color_id: colorId,
        tier_name: TIER_NAMES[tier] || 'Common',
        color_name: COLOR_NAMES[colorId] || 'Unknown',
        agent_id: agentId,
        btc_address: btcAddress,
        collection: 'Early Eagles',
        total_supply: 420,
      },
    });
  } catch (e) {
    console.error('Token API error:', e.message);
    return res.status(500).json({ error: 'Failed to fetch token data' });
  }
};
