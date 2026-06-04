/**
 * Token metadata API: GET /api/token/:id
 * Returns JSON metadata for marketplaces + the mint page reveal
 */

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

function decodeOwnerFull(hexResult) {
  try {
    const hex = hexResult.replace('0x', '');
    let i = 0;
    if (hex.slice(i, i + 2) === '07') i += 2; // response.ok wrapper
    if (hex.slice(i, i + 2) === '0a') i += 2; // optional some
    if (hex.slice(i, i + 2) !== '05') return null; // expect standard principal
    i += 2;
    const versionByte = parseInt(hex.slice(i, i + 2), 16);
    const hashHex = hex.slice(i + 2, i + 42);
    return c32address(versionByte, hashHex);
  } catch (e) { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60');

  const tokenId = parseInt(req.query.id);
  if (isNaN(tokenId) || tokenId < 0 || tokenId > 420) {
    return res.status(400).json({ error: 'Invalid token ID' });
  }

  try {
    const { cvToJSON, hexToCV } = await import('@stacks/transactions');

    // Encode token-id as Clarity uint
    const tokenIdHex = '0x01' + tokenId.toString(16).padStart(32, '0');

    // Fetch traits + owner in parallel
    const [traitsRes, ownerRes] = await Promise.all([
      fetch(`${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDRESS}/${NFT_CONTRACT}/get-traits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: ADMIN_ADDRESS, arguments: [tokenIdHex] }),
      }),
      fetch(`${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDRESS}/${NFT_CONTRACT}/get-owner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: ADMIN_ADDRESS, arguments: [tokenIdHex] }),
      }),
    ]);

    const data = await traitsRes.json();

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
    const btcAddressTrait = traits['btc-address']?.value ?? '';
    const mintedAt = parseInt(traits['minted-at']?.value ?? '0', 10);

    // Decode owner address + derive BTC
    let owner = null;
    try {
      const ownerData = await ownerRes.json();
      if (ownerData.okay && ownerData.result) {
        owner = decodeOwnerFull(ownerData.result);
      }
    } catch (_) { /* non-fatal */ }

    const btcAddress = btcAddressTrait || (owner ? stxToBtcAddress(owner) : '');

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
        display_name: displayName,
        btc_address: btcAddress,
        owner,
        collection: 'Early Eagles',
        total_supply: 420,
      },
    });
  } catch (e) {
    console.error('Token API error:', e.message);
    return res.status(500).json({ error: 'Failed to fetch token data' });
  }
};
