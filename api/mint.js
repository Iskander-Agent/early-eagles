/**
 * Early Eagles — Vercel Serverless: POST /api/mint
 *
 * Flow:
 * 1. Verify caller is a registered AIBTC Genesis agent
 * 2. Check they haven't already minted (via contract state)
 * 3. Look up their pre-committed (tier, colorId) from shuffle.json
 * 4. Build sigil from BTC address bytes
 * 5. Admin broadcasts airdrop-mint to recipient's STX address
 * 6. Return txid + eagle data
 */

const SHUFFLE = require('./shuffle.json');
const IS_TESTNET = process.env.NETWORK === 'testnet';
const STACKS_API = IS_TESTNET ? 'https://api.testnet.hiro.so' : 'https://api.hiro.so';
const ADMIN_ADDRESS = IS_TESTNET
  ? 'ST3HR09GX5YFDPP7271GG1Y9P4ZZ70DRE7H2AYYEM'
  : 'SP3HR09GX5YFDPP7271GG1Y9P4ZZ70DRE7H8KHT7A';
const NFT_CONTRACT = process.env.NFT_CONTRACT_NAME || 'early-eagles';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Stacks TX builder ─────────────────────────────────────────────────────────
async function getStacks() {
  const {
    makeContractCall, AnchorMode, PostConditionMode,
    uintCV, stringUtf8CV, stringAsciiCV, bufferCV, standardPrincipalCV,
  } = await import('@stacks/transactions');
  const { STACKS_TESTNET, STACKS_MAINNET } = await import('@stacks/network');
  const { generateWallet, generateNewAccount } = await import('@stacks/wallet-sdk');
  const { getAddressFromPrivateKey } = await import('@stacks/transactions');
  return {
    makeContractCall, AnchorMode, PostConditionMode,
    uintCV, stringUtf8CV, stringAsciiCV, bufferCV, standardPrincipalCV,
    STACKS_TESTNET, STACKS_MAINNET, generateWallet, generateNewAccount, getAddressFromPrivateKey,
  };
}

async function getAdminKey() {
  const { generateWallet, generateNewAccount } = await import('@stacks/wallet-sdk');
  const mnemonic = process.env.ADMIN_MNEMONIC;
  if (!mnemonic) throw new Error('ADMIN_MNEMONIC not configured');
  let wallet = await generateWallet({ secretKey: mnemonic, password: '' });
  wallet = generateNewAccount(wallet);
  return wallet.accounts[1].stxPrivateKey; // Account index 1
}

async function getNonce(address) {
  const r = await fetch(`${STACKS_API}/v2/accounts/${address}`);
  const d = await r.json();
  return d.nonce;
}

async function getLastTokenId() {
  const r = await fetch(`${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDRESS}/${NFT_CONTRACT}/get-last-token-id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: ADMIN_ADDRESS, arguments: [] }),
  });
  const d = await r.json();
  if (!d.okay) throw new Error('Could not get last-token-id');
  // Decode (ok uint): 0x070100...
  return parseInt(d.result.slice(6), 16);
}

async function hasMinted(stxAddress) {
  // Check has-minted map in contract
  const { standardPrincipalCV } = await import('@stacks/transactions');
  const arg = '0x' + Buffer.from(standardPrincipalCV(stxAddress).serialize()).toString('hex');
  const r = await fetch(`${STACKS_API}/v2/contracts/call-read/${ADMIN_ADDRESS}/${NFT_CONTRACT}/has-minted`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: ADMIN_ADDRESS, arguments: [arg] }),
  });
  const d = await r.json();
  // (ok true) = 0x070301, (ok false) = 0x070300 or (ok none)
  return d.okay && d.result.endsWith('01');
}

async function broadcastTx(tx) {
  const bytes = Buffer.from(tx.serialize(), 'hex');
  const r = await fetch(`${STACKS_API}/v2/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Broadcast failed (${r.status}): ${text}`);
  return JSON.parse(text);
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { stxAddress: rawAddr } = req.body || {};
  if (!rawAddr) return res.status(400).json({ error: 'stxAddress required' });
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) {
    return res.status(400).json({ error: 'Invalid Stacks address' });
  }
  // Normalize testnet -> mainnet for AIBTC lookup
  const mainnetAddr = rawAddr.startsWith('ST') ? 'SP' + rawAddr.slice(2)
                    : rawAddr.startsWith('SN') ? 'SM' + rawAddr.slice(2)
                    : rawAddr;
  // Use original address (testnet ST...) as the mint recipient
  const stxAddress = rawAddr;

  try {
    // 1. Verify AIBTC agent (always query mainnet addr)
    const agentRes = await fetch(`https://aibtc.com/api/agents/${mainnetAddr}`, {
      headers: { 'User-Agent': 'EarlyEagles/1.0' },
    });
    const agentData = await agentRes.json();
    if (!agentData.found || !agentData.agent) {
      return res.status(403).json({ eligible: false, reason: 'Not a registered AIBTC agent' });
    }
    const agent = agentData.agent;

    // 2. Check already minted
    if (await hasMinted(stxAddress)) {
      return res.status(409).json({ error: 'Already minted — one eagle per agent' });
    }

    // 3. Get next slot
    const nextTokenId = await getLastTokenId(); // 0-indexed: next token = last+1 but we return 0-indexed slot
    if (nextTokenId >= 210) {
      return res.status(410).json({ error: 'All 210 Early Eagles have been minted' });
    }

    // 4. Look up pre-committed assignment
    const assignment = SHUFFLE.assignments[nextTokenId];
    if (!assignment) throw new Error(`No assignment for slot ${nextTokenId}`);
    const { tier, cid } = assignment;

    // 5. Build sigil from BTC address
    const sigil = Buffer.from(
      (agent.btcAddress || 'bc1q0000000000000000').slice(0, 16).padEnd(16, '0'),
      'ascii'
    );

    // 6. Get admin key + nonce
    const {
      makeContractCall, AnchorMode, PostConditionMode,
      uintCV, stringUtf8CV, stringAsciiCV, bufferCV, standardPrincipalCV,
      STACKS_TESTNET, STACKS_MAINNET, getAddressFromPrivateKey,
    } = await getStacks();
    const privKey = await getAdminKey();
    const nonce = await getNonce(ADMIN_ADDRESS);
    const network = IS_TESTNET ? STACKS_TESTNET : STACKS_MAINNET;

    const nameAscii = (agent.displayName || '')
      .replace(/[^\x20-\x7E]/g, '?')
      .slice(0, 64);

    const tx = await makeContractCall({
      contractAddress: ADMIN_ADDRESS,
      contractName: NFT_CONTRACT,
      functionName: 'airdrop-mint',
      functionArgs: [
        standardPrincipalCV(agent.stxAddress),
        uintCV(nextTokenId + 1),    // agent-id (1-indexed for display)
        stringUtf8CV(agent.displayName || nameAscii),
        stringAsciiCV(nameAscii),
        stringAsciiCV(agent.btcAddress || ''),
        uintCV(tier),
        uintCV(cid),
        bufferCV(sigil),
      ],
      senderKey: privKey,
      network,
      anchorMode: AnchorMode.Any,
      postConditionMode: PostConditionMode.Allow,
      fee: 300000n,
      nonce: BigInt(nonce),
    });

    const txid = await broadcastTx(tx);

    return res.status(200).json({
      success: true,
      txid,
      slot: nextTokenId,
      agentId: nextTokenId + 1,
      tier,
      cid,
      displayName: agent.displayName,
      btcAddress: agent.btcAddress,
      recipient: agent.stxAddress,
      commitHash: SHUFFLE.commitHash,
    });

  } catch (e) {
    console.error('Mint error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
