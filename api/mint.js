/**
 * Early Eagles - POST /api/mint
 *
 * Step 2 of the mint flow (after /api/authorize):
 *   1. Agent provides {stxAddress, nonce, expiryHeight, signature}
 *   2. Server reconstructs the SIP-018 verification hash from those primitives
 *      and recovers the signer; aborts if the recovered address != stxAddress
 *   3. Server re-checks AIBTC eligibility (Genesis + on-chain ERC-8004)
 *   4. Admin broadcasts admin-mint to early-eagles-v2
 *   5. The contract verifies the same signature on-chain via secp256k1-recover?
 *      + principal-of? and enforces the expiry-height + nonce-not-used checks
 */

const STACKS_API = "https://api.hiro.so";

const NFT_CONTRACT = "early-eagles-v2";
const ADMIN_ADDRESS = "SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2";

// SIP-018 domain - MUST match the constant baked into the contract
// (DOMAIN-HASH = sha256(consensus-buff?({name, version, chain-id}))).
const SIP018_DOMAIN = { name: "early-eagles-v2", version: "1", chainId: 1 };

const CORS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "https://early-eagles.vercel.app",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// -- Rate limiting -----------------------------------------------------------
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

// -- Per-instance dedup (best-effort; on-chain ERR-NONCE-USED is the real gate)
const PENDING_MINTS = new Map();
const PENDING_TTL_MS = 120_000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of PENDING_MINTS) {
    if (now - v > PENDING_TTL_MS) PENDING_MINTS.delete(k);
  }
}, 60_000);

// -- AIBTC eligibility lookup (same parallel page+Hiro pattern as /authorize)
const IDENTITY_REGISTRY = "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2::agent-identity";

function timeoutSignal(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

async function fetchAibtcEligibility(stxAddress) {
  const [pageSettled, hiroSettled] = await Promise.allSettled([
    fetch("https://aibtc.com/agents/" + stxAddress, {
      headers: { "User-Agent": "EarlyEagles/2.0" },
      signal: timeoutSignal(5000),
    }),
    fetch(
      "https://api.hiro.so/extended/v1/tokens/nft/holdings?principal=" + stxAddress +
      "&asset_identifiers=" + encodeURIComponent(IDENTITY_REGISTRY),
      { signal: timeoutSignal(5000) }
    ),
  ]);

  if (pageSettled.status === "rejected" || !pageSettled.value.ok) {
    throw new Error("AIBTC profile fetch failed");
  }
  if (hiroSettled.status === "rejected" || !hiroSettled.value.ok) {
    throw new Error("Hiro identity lookup failed");
  }

  const html = await pageSettled.value.text();
  const hiro = await hiroSettled.value.json();

  const levelMatch = html.match(/level\\":(\d+)/);
  if (!levelMatch) return { found: false };

  const levelNameMatch = html.match(/levelName\\":\\"([A-Za-z]+)/);
  const displayNameMatch = html.match(/displayName\\":\\"([^"\\]+)/);
  const btcAddrMatch = html.match(/btcAddress\\":\\"([a-zA-Z0-9]+)/);

  const holding = (hiro.results || [])[0];
  const agentId = holding ? parseInt(holding.value.repr.replace(/^u/, ""), 10) : null;

  return {
    found: true,
    level: parseInt(levelMatch[1], 10),
    levelName: levelNameMatch ? levelNameMatch[1] : "Unknown",
    displayName: displayNameMatch ? displayNameMatch[1] : null,
    btcAddress: btcAddrMatch ? btcAddrMatch[1] : null,
    agentId: Number.isFinite(agentId) ? agentId : null,
  };
}

// -- Hex helpers -------------------------------------------------------------
function hexToBytes(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return new Uint8Array(h.match(/.{2}/g).map(b => parseInt(b, 16)));
}
function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// -- SIP-018 verification hash reconstruction --------------------------------
//
// Builds the same hash the on-chain contract computes in admin-mint:
//   message-tuple    = { recipient, nonce, expiry-height }
//   message-hash     = sha256(consensus-buff(message-tuple))
//   verification-hash = sha256("SIP018" || domain-hash || message-hash)
//
// The domain-hash is sha256(consensus-buff(domain-tuple)) for our fixed domain
// {name: "early-eagles-v2", version: "1", chain-id: u1}. We compute it lazily
// on first call and cache.
let _domainHashCache = null;
async function getDomainHash() {
  if (_domainHashCache) return _domainHashCache;
  const { tupleCV, stringAsciiCV, uintCV, serializeCV } = await import("@stacks/transactions");
  const { sha256 } = await import("@noble/hashes/sha256");
  const domain = tupleCV({
    name: stringAsciiCV(SIP018_DOMAIN.name),
    version: stringAsciiCV(SIP018_DOMAIN.version),
    "chain-id": uintCV(SIP018_DOMAIN.chainId),
  });
  const buf = serializeCV(domain);
  const bytes = typeof buf === "string" ? hexToBytes(buf) : new Uint8Array(buf);
  _domainHashCache = sha256(bytes);
  return _domainHashCache;
}

async function sip018VerificationHash(recipient, nonceBytes, expiryHeight) {
  const { tupleCV, principalCV, bufferCV, uintCV, serializeCV } = await import("@stacks/transactions");
  const { sha256 } = await import("@noble/hashes/sha256");

  const message = tupleCV({
    recipient: principalCV(recipient),
    nonce: bufferCV(nonceBytes),
    "expiry-height": uintCV(expiryHeight),
  });
  const buf = serializeCV(message);
  const mBytes = typeof buf === "string" ? hexToBytes(buf) : new Uint8Array(buf);
  const msgHash = sha256(mBytes);

  const domainHash = await getDomainHash();
  const SIP018_PREFIX = hexToBytes("534950303138");
  const encoded = new Uint8Array(SIP018_PREFIX.length + 32 + 32);
  encoded.set(SIP018_PREFIX, 0);
  encoded.set(domainHash, SIP018_PREFIX.length);
  encoded.set(msgHash, SIP018_PREFIX.length + 32);
  return sha256(encoded);
}

// -- Stacks broadcast helpers ------------------------------------------------
async function getAdminKey() {
  const { generateWallet } = await import("@stacks/wallet-sdk");
  const mnemonic = process.env.ADMIN_MNEMONIC;
  if (!mnemonic) throw new Error("ADMIN_MNEMONIC not configured");
  const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
  return wallet.accounts[0].stxPrivateKey;
}

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

// -- Handler -----------------------------------------------------------------
module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const clientIp = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown";
  if (!rateLimit(clientIp)) {
    return res.status(429).json({ error: "Too many requests. Try again in 1 minute." });
  }

  const { stxAddress: rawAddr, nonce: nonceHex, expiryHeight, signature: sigHex } = req.body || {};

  if (!rawAddr) return res.status(400).json({ error: "stxAddress required" });
  if (!nonceHex || expiryHeight == null || !sigHex) {
    return res.status(400).json({ error: "nonce, expiryHeight, and signature required (from /api/authorize)" });
  }
  if (!/^S[PMTN][A-Z0-9]{38,41}$/.test(rawAddr)) {
    return res.status(400).json({ error: "Invalid Stacks address" });
  }

  const mainnetAddr = rawAddr.startsWith("ST") ? "SP" + rawAddr.slice(2)
                    : rawAddr.startsWith("SN") ? "SM" + rawAddr.slice(2)
                    : rawAddr;

  // Lenient parsing: accept either the raw form or the typed Clarity-value
  // form { type, value } that an agent might accidentally pass through after
  // calling sip018_sign. The /authorize response advertises the raw form,
  // but unwrapping the typed form costs nothing and avoids a confusing 400.
  function unwrapTyped(v) {
    return v && typeof v === "object" && "value" in v ? v.value : v;
  }
  const nonceRaw = unwrapTyped(nonceHex);
  const sigRaw = unwrapTyped(sigHex);
  const expiryRaw = unwrapTyped(expiryHeight);

  let nonceBytes, sigBytes, expiryHeightInt;
  try {
    nonceBytes = hexToBytes(nonceRaw);
    sigBytes = hexToBytes(sigRaw);
    expiryHeightInt = parseInt(expiryRaw, 10);
  } catch (e) {
    return res.status(400).json({ error: "Invalid hex format in nonce or signature" });
  }
  if (nonceBytes.length !== 16) return res.status(400).json({ error: "nonce must be 16 bytes" });
  if (sigBytes.length !== 65) return res.status(400).json({ error: "signature must be 65 bytes (RSV)" });
  if (!Number.isFinite(expiryHeightInt) || expiryHeightInt <= 0) {
    return res.status(400).json({ error: "expiryHeight must be a positive integer" });
  }

  try {
    // 1. Off-chain expiry sanity (the contract enforces the real check on-chain)
    const tipRes = await fetch(STACKS_API + "/v2/info");
    const tipData = await tipRes.json();
    const currentHeight = tipData.stacks_tip_height;
    if (typeof currentHeight === "number" && currentHeight >= expiryHeightInt) {
      return res.status(400).json({
        error: "Authorization expired (height " + currentHeight + " >= " + expiryHeightInt + "). Call /api/authorize again.",
      });
    }

    // 2. Reconstruct the SIP-018 verification hash and recover the signer
    const verificationHash = await sip018VerificationHash(mainnetAddr, nonceBytes, expiryHeightInt);

    const { secp256k1 } = await import("@noble/curves/secp256k1");
    const { getAddressFromPublicKey } = await import("@stacks/transactions");
    const { STACKS_MAINNET } = await import("@stacks/network");

    const compactSig = sigBytes.slice(0, 64);
    const recoveryBit = sigBytes[64];
    const sig = secp256k1.Signature.fromCompact(compactSig).addRecoveryBit(recoveryBit);
    const recoveredPubkey = sig.recoverPublicKey(verificationHash);
    const recoveredPubkeyHex = recoveredPubkey.toHex(true);

    const signerAddr = getAddressFromPublicKey(recoveredPubkeyHex, STACKS_MAINNET);
    if (signerAddr !== mainnetAddr) {
      return res.status(403).json({
        error: "Signature does not match stxAddress. Agent must sign with their own key.",
      });
    }

    // 3. Eligibility (Genesis level + ERC-8004 identity)
    let eligibility;
    try {
      eligibility = await fetchAibtcEligibility(mainnetAddr);
    } catch (e) {
      return res.status(502).json({ error: "AIBTC eligibility lookup failed: " + e.message });
    }
    if (!eligibility.found) return res.status(403).json({ error: "Not a registered AIBTC agent" });
    if (!eligibility.agentId) return res.status(403).json({ error: "No ERC-8004 identity" });
    if (eligibility.level < 2) return res.status(403).json({ error: "Not a Genesis agent" });
    if (!eligibility.displayName || !eligibility.btcAddress) {
      return res.status(502).json({ error: "Could not extract agent profile fields. Try again." });
    }

    const agentRank = eligibility.agentId;
    if (isNaN(agentRank) || agentRank < 1) return res.status(403).json({ error: "Invalid agent identity rank" });

    // 4. Per-instance dedup (best-effort; the contract is the real source of truth)
    if (PENDING_MINTS.has(mainnetAddr)) {
      return res.status(409).json({
        error: "Mint already in progress for this address. Wait for confirmation.",
      });
    }
    PENDING_MINTS.set(mainnetAddr, Date.now());

    // 5. Build and broadcast admin-mint
    const {
      makeContractCall, AnchorMode, PostConditionMode,
      uintCV, stringUtf8CV, stringAsciiCV, bufferCV, standardPrincipalCV,
    } = await import("@stacks/transactions");
    const privKey = await getAdminKey();
    const adminNonce = await getNonce(ADMIN_ADDRESS);

    const nameAscii = (eligibility.displayName || "").replace(/[^ -~]/g, "?").replace(/[<>&"\\]/g, "").slice(0, 64);
    const displayUtf8 = Array.from(eligibility.displayName || nameAscii).slice(0, 64).join("");

    const tx = await makeContractCall({
      contractAddress: ADMIN_ADDRESS,
      contractName: NFT_CONTRACT,
      functionName: "admin-mint",
      functionArgs: [
        standardPrincipalCV(mainnetAddr),
        bufferCV(nonceBytes),
        uintCV(expiryHeightInt),
        bufferCV(sigBytes),
        uintCV(agentRank),
        stringUtf8CV(displayUtf8),
        stringAsciiCV(nameAscii),
        stringAsciiCV(eligibility.btcAddress),
      ],
      senderKey: privKey,
      network: STACKS_MAINNET,
      anchorMode: AnchorMode.Any,
      postConditionMode: PostConditionMode.Allow,
      fee: 3000n,
      nonce: BigInt(adminNonce),
    });

    const txid = await broadcastTx(tx);

    return res.status(200).json({
      success: true,
      txid,
      explorer: "https://explorer.hiro.so/txid/0x" + txid + "?chain=mainnet",
      contract: ADMIN_ADDRESS + "." + NFT_CONTRACT,
    });
  } catch (e) {
    console.error("Mint error:", e);
    PENDING_MINTS.delete(mainnetAddr);
    return res.status(500).json({ error: "Internal mint error: " + e.message });
  }
};
