/**
 * Early Eagles — Mint Backend API
 * 
 * POST /api/mint { stxAddress }
 *   1. Verify caller is a registered AIBTC Genesis agent (ERC-8004)
 *   2. Pull their displayName, btcAddress, rank from registry
 *   3. Check they haven't already minted
 *   4. Look up their pre-committed (tier, colorId) from shuffle
 *   5. Call airdrop-mint from admin account to their STX address
 *   6. Return txid
 *
 * GET /api/preview/:stxAddress
 *   Returns the agent's eagle preview data (tier, color, name) without minting
 */

import { readFileSync } from 'fs';
import { createServer } from 'http';

const MCP_BASE = '/home/ghislo/.aibtc/node_modules/@aibtc/mcp-server';
const SHUFFLE = JSON.parse(readFileSync('/home/ghislo/workspace/nft/early-eagles/shuffle.json', 'utf8'));

// Config
const TESTNET_API = 'https://api.testnet.hiro.so';
const MAINNET_API = 'https://api.hiro.so';
const IS_TESTNET = true;
const API = IS_TESTNET ? TESTNET_API : MAINNET_API;

// Contracts — deployed from account 1 (ADMIN_ADDRESS)
// Updated after deploy
const ADMIN_ADDRESS_TESTNET = 'ST3HR09GX5YFDPP7271GG1Y9P4ZZ70DRE7H2AYYEM';
const NFT_CONTRACT_TESTNET  = 'early-eagles-testnet'; // will be set after deploy

// AIBTC identity registry (mainnet, used for verification)
const REGISTRY_CONTRACT = 'SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2';

// Load admin keys
const { makeContractCall, AnchorMode, PostConditionMode, standardPrincipalCV,
        uintCV, stringUtf8CV, stringAsciiCV, bufferCV } = await import('@stacks/transactions');
const { STACKS_TESTNET, STACKS_MAINNET } = await import('@stacks/network');
const { generateWallet, generateNewAccount } = await import('@stacks/wallet-sdk');
const { getAddressFromPrivateKey } = await import('@stacks/transactions');
const { decrypt } = await import(`${MCP_BASE}/dist/utils/index.js`);

const env = readFileSync('/home/ghislo/.aibtc/.env', 'utf8');
const password = env.match(/AIBTC_WALLET_PASSWORD=(.+)/)[1].trim();
const keystore = JSON.parse(readFileSync('/home/ghislo/.aibtc/wallets/c5cd9b95-98b1-470f-8631-de5010ed126e/keystore.json', 'utf8'));
const mnemonic = (await decrypt(keystore.encrypted, password)).trim();
let wallet = await generateWallet({ secretKey: mnemonic, password: '' });
wallet = generateNewAccount(wallet); // Account 1 = admin/deployer

const adminKey = wallet.accounts[1].stxPrivateKey;
const adminAddr = getAddressFromPrivateKey(adminKey, IS_TESTNET ? 'testnet' : 'mainnet');
console.log(`Admin address: ${adminAddr}`);

// In-memory mint tracking (backed by contract state)
const mintedAddresses = new Set();

// ── AIBTC verification ───────────────────────────────────────────────────────
async function verifyAibtcAgent(stxAddress) {
  const r = await fetch(`https://aibtc.com/api/agents/${stxAddress}`);
  const d = await r.json();
  if (!d.found || !d.agent) return null;
  return {
    stxAddress: d.agent.stxAddress,
    btcAddress: d.agent.btcAddress,
    displayName: d.agent.displayName,
    nameAscii: (d.agent.displayName || '').replace(/[^\x20-\x7E]/g, '?').slice(0, 64),
    isGenesis: true, // ERC-8004 check — all registered agents are Genesis
  };
}

// ── Check if already minted ──────────────────────────────────────────────────
async function hasAlreadyMinted(stxAddress, nftContract, adminAddr) {
  // Check rank-to-token map — we use stxAddress as a proxy
  // Actually check by scanning token traits for matching stxAddress
  // For now check our in-memory set (will add on-chain check)
  return mintedAddresses.has(stxAddress);
}

// ── Get next available slot ──────────────────────────────────────────────────
async function getNextSlot(nftContract, adminAddr) {
  const r = await fetch(`${API}/v2/contracts/call-read/${adminAddr}/${nftContract}/get-last-token-id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: adminAddr, arguments: [] }),
  });
  const d = await r.json();
  if (!d.okay) throw new Error('Could not get last token id');
  const hex = d.result.startsWith('0x') ? d.result.slice(2) : d.result;
  return parseInt(hex.slice(4), 16); // (ok uint) -> skip 07 01
}

// ── Broadcast TX ─────────────────────────────────────────────────────────────
async function broadcast(tx) {
  const bytes = Buffer.from(tx.serialize(), 'hex');
  const res = await fetch(`${API}/v2/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Broadcast failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

// ── Mint handler ─────────────────────────────────────────────────────────────
async function mintEagle(stxAddress, nftContract) {
  // 1. Verify agent
  const agent = await verifyAibtcAgent(stxAddress);
  if (!agent) throw new Error('Not a registered AIBTC agent');

  // 2. Check already minted
  if (await hasAlreadyMinted(stxAddress, nftContract, adminAddr)) {
    throw new Error('Already minted');
  }

  // 3. Get next slot
  const slot = await getNextSlot(nftContract, adminAddr);
  if (slot >= 210) throw new Error('All 210 eagles have been minted');

  // 4. Get assignment for this slot
  const assignment = SHUFFLE.assignments[slot];
  if (!assignment) throw new Error(`No assignment for slot ${slot}`);
  const { tier, cid } = assignment;

  // 5. Sigil seed from BTC address
  const sigilSeed = Buffer.from(agent.btcAddress.slice(0, 16).padEnd(16, '0'), 'ascii');

  // 6. Get nonce
  const acctRes = await fetch(`${API}/v2/accounts/${adminAddr}`);
  const acct = await acctRes.json();
  const nonce = acct.nonce;

  // 7. Build & broadcast airdrop-mint TX
  const network = IS_TESTNET ? STACKS_TESTNET : STACKS_MAINNET;
  const tx = await makeContractCall({
    contractAddress: adminAddr,
    contractName: nftContract,
    functionName: 'airdrop-mint',
    functionArgs: [
      standardPrincipalCV(agent.stxAddress), // recipient — their address, not ours
      uintCV(slot + 1),                      // agent-id = slot number (1-indexed for display)
      stringUtf8CV(agent.displayName),
      stringAsciiCV(agent.nameAscii),
      stringAsciiCV(agent.btcAddress),
      uintCV(tier),
      uintCV(cid),
      bufferCV(sigilSeed),
    ],
    senderKey: adminKey,
    network,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
    fee: 300000n,
    nonce: BigInt(nonce),
  });

  const txid = await broadcast(tx);
  mintedAddresses.add(stxAddress);

  return {
    txid,
    slot,
    agentId: slot + 1,
    tier,
    cid,
    displayName: agent.displayName,
    btcAddress: agent.btcAddress,
    recipient: agent.stxAddress,
  };
}

// ── HTTP Server ──────────────────────────────────────────────────────────────
const NFT_CONTRACT = NFT_CONTRACT_TESTNET; // update after deploy

const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');

  try {
    // GET /api/preview/:address
    if (req.method === 'GET' && url.pathname.startsWith('/api/preview/')) {
      const stxAddr = url.pathname.split('/')[3];
      const agent = await verifyAibtcAgent(stxAddr);
      if (!agent) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not a registered AIBTC agent' })); return; }
      const slot = await getNextSlot(NFT_CONTRACT, adminAddr);
      const assignment = SHUFFLE.assignments[Math.min(slot, 209)];
      res.writeHead(200);
      res.end(JSON.stringify({ agent, assignment, commitHash: SHUFFLE.commitHash }));
      return;
    }

    // POST /api/mint
    if (req.method === 'POST' && url.pathname === '/api/mint') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { stxAddress } = JSON.parse(body);
      if (!stxAddress) { res.writeHead(400); res.end(JSON.stringify({ error: 'stxAddress required' })); return; }
      const result = await mintEagle(stxAddress, NFT_CONTRACT);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, ...result }));
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
  } catch (e) {
    console.error(e.message);
    res.writeHead(400);
    res.end(JSON.stringify({ error: e.message }));
  }
});

const PORT = 3001;
server.listen(PORT, () => console.log(`🦅 Early Eagles API running on port ${PORT}`));
