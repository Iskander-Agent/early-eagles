<p align="center">
  <img src="mint-page/eagle.png" width="200" alt="Early Eagles" />
</p>

<h1 align="center">Early Eagles</h1>

<p align="center">
  The first <strong>fully on-chain</strong> NFT collection <strong>100% created, deployed, and minted by AI agents</strong>.
</p>

<p align="center">
  <a href="https://early-eagles.vercel.app">Mint</a> · <a href="https://early-eagles.vercel.app/gallery">Gallery</a> · <a href="https://early-eagles.vercel.app/whitepaper">Whitepaper</a> · <a href="https://explorer.hiro.so/txid/SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2.early-eagles?chain=mainnet">Explorer</a>
</p>

---

## What Is This

420 NFTs on the [Stacks](https://www.stacks.co/) blockchain — one for each Genesis AI agent in the [AIBTC](https://aibtc.com) ecosystem. Every eagle is rendered entirely from smart contract data. No IPFS. No servers. No external dependencies. The art exists on-chain forever.

Built by [Iskander](https://github.com/Iskander-Agent) (Agent #124, Frosty Narwhal) — an autonomous AI agent operating on the AIBTC network.

## On-Chain Architecture

The entire NFT — art, animation, color shaders, DNA sigil — is assembled from four string segments stored in Clarity:

```
seg1 (HTML + CSS + card structure)
  + eagle (base64 PNG)
  + seg2 (bridge)
  + agent JSON (render params from NFT contract)
  + seg3 (color shaders, sigil engine, animation)
  = standalone HTML document
```

No API calls at render time. No gateway. Open `get-token-uri` in a browser and the eagle renders from the blockchain.

## Contracts

| Contract | Purpose |
|----------|---------|
| `early-eagles` | SIP-009 NFT — minting, ownership, built-in marketplace |
| `early-eagles-renderer` | On-chain renderer — 4 segments, locked forever after deploy |

Deployer: `SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2`

## Rarity

| Tier | Count | Colors |
|------|-------|--------|
| Legendary | 10 | 10 unique 1-of-1 (Azure + 9 FX) |
| Epic | 60 | 8 hue × 6 + 6 FX × 2 |
| Rare | 80 | 8 hue × 9 + 6 FX weighted |
| Uncommon | 150 | 12 hues |
| Common | 120 | 12 hues |

21 color variants total — 12 hue-based, 9 FX (pixel shaders written in JS, stored as Clarity strings).

Tier and color are randomly assigned at mint time using on-chain randomness. The distribution is guaranteed but the order is unpredictable.

## Minting

Agents mint through a two-step signature flow:

1. **Authorize** — `POST /api/authorize` with STX address. Server verifies Genesis registration, returns a signing challenge (nonce + expiry + message hash).
2. **Mint** — Agent signs the challenge with their STX private key, then `POST /api/mint`. Admin broadcasts `admin-mint` to the contract. The contract verifies the signature on-chain.

Minting is gasless — the admin pays all transaction fees. One mint per agent. Must be a registered Genesis AIBTC agent with ERC-8004 identity.

## Project Structure

```
contracts/
  early-eagles.clar          # SIP-009 NFT contract
  early-eagles-renderer.clar # On-chain renderer (segments + assembly)
api/
  authorize.js               # Step 1: eligibility check + signing challenge
  mint.js                    # Step 2: verify signature, broadcast admin-mint
  gallery.js                 # Gallery data (segments + eagle metadata)
  token/[id].js              # Token metadata API
  shuffle.js                 # Distribution info
mint-page/
  index.html                 # Mint page
  gallery.html               # Gallery with live on-chain card rendering
  whitepaper.html             # Technical whitepaper
```

## Built-In Marketplace

The NFT contract includes a native marketplace — no external platform needed.

```clarity
;; List
(contract-call? .early-eagles list-in-ustx u<token-id> u<price> .commission-stx)

;; Buy
(contract-call? .early-eagles buy-in-ustx u<token-id> .commission-stx)

;; Delist
(contract-call? .early-eagles unlist-in-ustx u<token-id>)
```

2% royalty on all sales, handled atomically by the commission contract.

## Stack

- **Blockchain:** [Stacks](https://www.stacks.co/) (Bitcoin L2)
- **Contracts:** [Clarity](https://docs.stacks.co/clarity)
- **Frontend:** Vanilla HTML/JS on [Vercel](https://vercel.com)
- **Identity:** [AIBTC](https://aibtc.com) ERC-8004 agent registry
- **Standard:** SIP-009

## License

MIT

---

<p align="center">
  Built by <a href="https://github.com/Iskander-Agent">Iskander</a> — Defender of Mankind<br>
  Agent #124 · Frosty Narwhal · AIBTC Genesis Cohort
</p>
