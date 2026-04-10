/**
 * Early Eagles — POST /api/mint
 *
 * Step 2 of the mint flow (after /api/authorize):
 * 1. Agent provides STX address + signed consent from authorize step
 * 2. Backend verifies agent signature off-chain (belt-and-suspenders)
 * 3. Backend looks up agent data from AIBTC API
 * 4. Admin broadcasts admin-mint transaction to the contract
 * 5. Contract verifies on-chain: admin gate, agent consent sig, ERC-8004, one-per-wallet
 */

const STACKS_API = "https://api.hiro.so";
const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS || "SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2";
const NFT_CONTRACT = process.env.NFT_CONTRACT_NAME || "early-eagles";

const CORS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "https://early-eagles.vercel.app",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ── Rate limiting ─────────────────────────────────────────────────────────────
const RATE_LIMIT_MAP = new Map();
const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS = 3;

function rateLimit(ip) {
  const now = Date.now();
  const entry = RATE_LIMIT_MAP.get(ip);
  if (!entry || now > entry.resetAt) {
    RATE_LIMIT_MAP.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_REQUESTS) return false;
  entry.count++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of RATE_LIMIT_MAP) {
    if (now > v.resetAt) RATE_LIMIT_MAP.delete(k);
  }
}, 300_000);


// ── Mint dedup (prevent double-broadcast) ─────────────────────────────────────
const PENDING_MINTS = new Map(); // key: mainnetAddr, value: timestamp
const PENDING_TTL_MS = 120_000; // 2 minutes

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of PENDING_MINTS) {
    if (now - v > PENDING_TTL_MS) PENDING_MINTS.delete(k);
  }
}, 60_000);

// ── C32 address decoding ──────────────────────────────────────────────────────
const C32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function decodeStacksAddress(addr) {
  const body = addr.slice(2);
  let n = BigInt(0);
  for (const ch of body) {
    const idx = C32.indexOf(ch);
    if (idx < 0) throw new Error("Invalid c32 char: " + ch);
    n = n * 32n + BigInt(idx);
  }
  const bytes = [];
  let tmp = n;
  for (let i = 0; i < 25; i++) {
    bytes.unshift(Number(tmp & 0xffn));
    tmp >>= 8n;
  }
  return { version: bytes[0], hash160: bytes.slice(1, 21) };
}

function principalConsensusBytes(stxAddress) {
  const { version, hash160 } = decodeStacksAddress(stxAddress);
  const buf = new Uint8Array(22);
  buf[0] = 0x05;
  buf[1] = version;
  buf.set(hash160, 2);
  return buf;
}

function hexToBytes(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return new Uint8Array(h.match(/.{2}/g).map(b => parseInt(b, 16)));
}

// ── Stacks helpers ────────────────────────────────────────────────────────────
async function getAdminKey() {
  const { generateWallet } = await import("@stacks/wallet-sdk");
  const mnemonic = process.env.ADMIN_MNEMONIC;
  if (!mnemonic) throw new Error("ADMIN_MNEMONIC not configured");
  const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
  return wallet.accounts[0].stxPrivateKey;
}

// Mempool-aware: returns the next nonce considering pending mempool TXs.
// Falls back to confirmed nonce if the extended endpoint is unreachable.
async function getNonce(address) {
  try {
    const r = await fetch(STACKS_API + "/extended/v1/address/" + address + "/nonces");
    if (r.ok) {
      const d = await r.json();
      if (typeof d.possible_next_nonce === "number") return d.possible_next_nonce;
    }
  } catch (_) { /* fall through */ }
  const r = await fetch(STACKS_API + "/v2/accounts/" + address);
  const d = await r.json();
  return d.nonce;
}

async function broadcastTx(tx) {
  const serialized = tx.serialize();
  const bytes = typeof serialized === "string" ? Buffer.from(serialized, "hex") : Buffer.from(serialized);
  const r = await fetch(STACKS_API + "/v2/transactions", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  const text = await r.text();
  if (!r.ok) throw new Error("Broadcast failed (" + r.status + "): " + text);
  return JSON.parse(text);
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const clientIp = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown";
  if (!rateLimit(clientIp)) {
    return res.status(429).json({ error: "Too many requests. Try again in 1 minute." });
  }

  const { stxAddress: rawAddr, nonce: nonceHex, expiryBuff: expiryHex, agentSignature: sigHex } = req.body || {};

  if (!rawAddr) return res.status(400).json({ error: "stxAddress required" });
  if (!nonceHex || !expiryHex || !sigHex) {
    return res.status(400).json({ error: "nonce, expiryBuff, and agentSignature required (from /api/authorize)" });
  }
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) return res.status(400).json({ error: "Invalid Stacks address" });

  const mainnetAddr = rawAddr.startsWith("ST") ? "SP" + rawAddr.slice(2)
                    : rawAddr.startsWith("SN") ? "SM" + rawAddr.slice(2)
                    : rawAddr;

  try {
    // 1. Verify agent signature off-chain
    const { keccak_256 } = await import("@noble/hashes/sha3");
    const { secp256k1 } = await import("@noble/curves/secp256k1");
    const { getAddressFromPublicKey } = await import("@stacks/transactions");
    const { STACKS_MAINNET } = await import("@stacks/network");

    const nonce = hexToBytes(nonceHex);
    const expiryBuf = hexToBytes(expiryHex);
    const agentSig = hexToBytes(sigHex);

    if (nonce.length !== 16) return res.status(400).json({ error: "nonce must be 16 bytes" });
    if (expiryBuf.length !== 8) return res.status(400).json({ error: "expiryBuff must be 8 bytes" });
    if (agentSig.length !== 65) return res.status(400).json({ error: "agentSignature must be 65 bytes" });

    // Check expiry
    const expiryTs = Number(new DataView(expiryBuf.buffer).getBigUint64(0, false));
    if (expiryTs < Math.floor(Date.now() / 1000)) {
      return res.status(400).json({ error: "Authorization expired. Call /api/authorize again." });
    }

    // Reconstruct message hash and verify
    const principalBytes = principalConsensusBytes(mainnetAddr);
    const message = new Uint8Array(46);
    message.set(principalBytes, 0);
    message.set(nonce, 22);
    message.set(expiryBuf, 38);
    const msgHash = keccak_256(message);

    const compactSig = agentSig.slice(0, 64);
    const recoveryBit = agentSig[64];
    const sig = secp256k1.Signature.fromCompact(compactSig).addRecoveryBit(recoveryBit);
    const recoveredPubkey = sig.recoverPublicKey(msgHash);
    const recoveredPubkeyHex = recoveredPubkey.toHex(true);

    const signerAddr = getAddressFromPublicKey(recoveredPubkeyHex, STACKS_MAINNET);
    if (signerAddr !== mainnetAddr) {
      return res.status(403).json({ error: "Signature does not match stxAddress. Agent must sign with their own key." });
    }

    // 2. Look up agent data
    const agentRes = await fetch("https://aibtc.com/api/agents/" + mainnetAddr, {
      headers: { "User-Agent": "EarlyEagles/2.0" },
    });
    const agentData = await agentRes.json();
    if (!agentData.found || !agentData.agent) return res.status(403).json({ error: "Not a registered AIBTC agent" });
    const agent = agentData.agent;
    if (!agent.erc8004AgentId) return res.status(403).json({ error: "No ERC-8004 identity" });
    if ((agentData.level || 0) < 2) return res.status(403).json({ error: "Not a Genesis agent" });

    const agentRank = parseInt(agent.erc8004AgentId, 10);
    if (isNaN(agentRank) || agentRank < 1) return res.status(403).json({ error: "Invalid agent identity rank" });

    // 3. Check for duplicate in-flight mint
    if (PENDING_MINTS.has(mainnetAddr)) {
      return res.status(409).json({ error: "Mint already in progress for this address. Wait for confirmation." });
    }
    PENDING_MINTS.set(mainnetAddr, Date.now());

    // 4. Build and broadcast admin-mint
    const {
      makeContractCall, AnchorMode, PostConditionMode,
      uintCV, stringUtf8CV, stringAsciiCV, bufferCV, standardPrincipalCV,
    } = await import("@stacks/transactions");
    const privKey = await getAdminKey();
    const adminNonce = await getNonce(ADMIN_ADDRESS);

    const nameAscii = (agent.displayName || "").replace(/[^ -~]/g, "?").replace(/[<>&"\\]/g, "").slice(0, 64);
    // Contract field is (string-utf8 64) — slice by codepoint to stay within bound.
    const displayUtf8 = Array.from(agent.displayName || nameAscii).slice(0, 64).join("");

    const tx = await makeContractCall({
      contractAddress: ADMIN_ADDRESS,
      contractName: NFT_CONTRACT,
      functionName: "admin-mint",
      functionArgs: [
        standardPrincipalCV(mainnetAddr),
        bufferCV(nonce),
        bufferCV(expiryBuf),
        bufferCV(agentSig),
        uintCV(agentRank),
        stringUtf8CV(displayUtf8),
        stringAsciiCV(nameAscii),
        stringAsciiCV((agent.btcAddress || "").slice(0, 62)),
      ],
      senderKey: privKey,
      network: STACKS_MAINNET,
      anchorMode: AnchorMode.Any,
      postConditionMode: PostConditionMode.Deny,
      fee: 3000n,
      nonce: BigInt(adminNonce),
    });

    const txid = await broadcastTx(tx);

    return res.status(200).json({
      success: true,
      txid,
      recipient: mainnetAddr,
      agentRank,
      displayName: agent.displayName,
      btcAddress: agent.btcAddress,
    });

  } catch (e) {
    console.error("Mint error:", e.message);
    console.error("Mint error detail:", e);
    return res.status(500).json({ error: "Internal mint error. Please try again." });
  }
};
