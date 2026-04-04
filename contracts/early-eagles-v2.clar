;; early-eagles-v2.clar
;; Early Eagles — Genesis AIBTC Agent NFT Collection
;; SIP-009 compliant with built-in STX + sBTC marketplace and agent gating.
;;
;; Architecture:
;;   - 210 NFTs, one per registered AIBTC agent (rank 1–210)
;;   - Traits stored on-chain: tier, color-id, display-name, btc-address, sigil-seed
;;   - get-token-uri returns on-chain rendered card via renderer contract
;;   - Built-in marketplace: list/unlist/buy in STX or sBTC
;;   - 5% royalty on secondary sales via commission contracts
;;   - Agent gating: only the registered AIBTC agent for a given rank can claim their NFT
;;
;; Deploy order:
;;   1. commission-trait
;;   2. commission-stx
;;   3. commission-sbtc
;;   4. this contract

;; ── Traits ────────────────────────────────────────────────────────────────────

(impl-trait 'SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9.nft-trait.nft-trait)
(use-trait commission-trait .commission-trait.commission)
(use-trait sip010-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

;; ── NFT Definition ─────────────────────────────────────────────────────────────

(define-non-fungible-token early-eagle uint)

;; ── Constants ──────────────────────────────────────────────────────────────────

(define-constant CONTRACT-OWNER tx-sender)
(define-constant MAX-SUPPLY u210)

;; Mainnet sBTC
(define-constant SBTC-CONTRACT 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)

;; AIBTC Identity Registry (for agent gating)
(define-constant AIBTC-REGISTRY 'SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2)

;; Errors
(define-constant ERR-NOT-AUTHORIZED    (err u401))
(define-constant ERR-NOT-FOUND         (err u404))
(define-constant ERR-SOLD-OUT          (err u300))
(define-constant ERR-ALREADY-MINTED    (err u301))
(define-constant ERR-LISTING           (err u302)) ;; token is listed, use buy or unlist
(define-constant ERR-NOT-LISTED        (err u303))
(define-constant ERR-WRONG-COMMISSION  (err u304))
(define-constant ERR-WRONG-CURRENCY    (err u305))
(define-constant ERR-WRONG-TOKEN       (err u306))
(define-constant ERR-NOT-AGENT         (err u307)) ;; caller is not a registered AIBTC agent
(define-constant ERR-RANK-TAKEN        (err u308))

;; ── Storage ───────────────────────────────────────────────────────────────────

(define-data-var total-minted uint u0)
(define-data-var metadata-frozen bool false)

;; On-chain traits per token
(define-map token-traits uint {
  tier:         uint,           ;; 0=Legendary 1=Epic 2=Rare 3=Uncommon 4=Common
  color-id:     uint,           ;; 0–20, see color table
  agent-id:     uint,           ;; AIBTC agent rank (1–210)
  display-name: (string-utf8 64),
  btc-address:  (string-ascii 62),
  stx-address:  principal,
  sigil-seed:   (buff 16),
  minted-at:    uint
})

;; rank → token-id (prevents double-claiming a rank)
(define-map rank-to-token uint uint)

;; Marketplace listings
(define-map market uint {
  price:      uint,
  commission: principal,
  currency:   (string-ascii 4)  ;; "STX" or "SBTC"
})

;; ── SIP-009 Required Functions ────────────────────────────────────────────────

(define-read-only (get-last-token-id)
  (ok (var-get total-minted)))

(define-read-only (get-owner (token-id uint))
  (ok (nft-get-owner? early-eagle token-id)))

(define-read-only (get-token-uri (token-id uint))
  ;; Returns on-chain renderer URI — renderer contract generates the full HTML card
  (ok (some (concat
    "https://early-eagles.vercel.app/api/token/"
    (uint-to-ascii token-id)))))

(define-public (transfer (token-id uint) (sender principal) (recipient principal))
  (begin
    (asserts! (is-eq tx-sender sender) ERR-NOT-AUTHORIZED)
    ;; Block transfer if listed — must unlist first
    (asserts! (is-none (map-get? market token-id)) ERR-LISTING)
    (nft-transfer? early-eagle token-id sender recipient)))

;; ── Read Helpers ──────────────────────────────────────────────────────────────

(define-read-only (get-traits (token-id uint))
  (map-get? token-traits token-id))

(define-read-only (get-listing (token-id uint))
  (map-get? market token-id))

(define-read-only (get-token-for-rank (rank uint))
  (map-get? rank-to-token rank))

(define-read-only (get-mint-stats)
  { total-minted: (var-get total-minted), max-supply: MAX-SUPPLY })

;; ── Agent Gating ──────────────────────────────────────────────────────────────

;; Check that tx-sender is the registered STX wallet for the given AIBTC agent rank.
;; Calls identity-registry-v2 get-agent-wallet.
(define-private (is-registered-agent (agent-id uint))
  (match (contract-call? AIBTC-REGISTRY get-agent-wallet agent-id)
    wallet (is-eq tx-sender wallet)
    false))

;; ── Minting ───────────────────────────────────────────────────────────────────

;; Agents claim their own NFT.
;; Caller must be the registered STX wallet for `agent-id` in the AIBTC registry.
(define-public (claim
    (agent-id uint)
    (display-name (string-utf8 64))
    (btc-addr (string-ascii 62))
    (tier uint)
    (color-id uint)
    (sigil-seed (buff 16)))
  (let ((token-id (var-get total-minted)))
    (asserts! (<= token-id MAX-SUPPLY) ERR-SOLD-OUT)
    (asserts! (is-none (map-get? rank-to-token agent-id)) ERR-RANK-TAKEN)
    (asserts! (is-registered-agent agent-id) ERR-NOT-AGENT)
    (try! (nft-mint? early-eagle token-id tx-sender))
    (map-set token-traits token-id {
      tier:         tier,
      color-id:     color-id,
      agent-id:     agent-id,
      display-name: display-name,
      btc-address:  btc-addr,
      stx-address:  tx-sender,
      sigil-seed:   sigil-seed,
      minted-at:    stacks-block-height
    })
    (map-set rank-to-token agent-id token-id)
    (var-set total-minted (+ token-id u1))
    (ok { token-id: token-id })))

;; Owner-only: airdrop mint for initial distribution (bypasses agent gating).
;; Used for the genesis airdrop to all 210 agents at launch.
(define-public (airdrop-mint
    (recipient principal)
    (agent-id uint)
    (display-name (string-utf8 64))
    (btc-addr (string-ascii 62))
    (tier uint)
    (color-id uint)
    (sigil-seed (buff 16)))
  (let ((token-id (var-get total-minted)))
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-AUTHORIZED)
    (asserts! (<= token-id MAX-SUPPLY) ERR-SOLD-OUT)
    (asserts! (is-none (map-get? rank-to-token agent-id)) ERR-RANK-TAKEN)
    (try! (nft-mint? early-eagle token-id recipient))
    (map-set token-traits token-id {
      tier:         tier,
      color-id:     color-id,
      agent-id:     agent-id,
      display-name: display-name,
      btc-address:  btc-addr,
      stx-address:  recipient,
      sigil-seed:   sigil-seed,
      minted-at:    stacks-block-height
    })
    (map-set rank-to-token agent-id token-id)
    (var-set total-minted (+ token-id u1))
    (ok { token-id: token-id })))

;; ── Marketplace — STX ─────────────────────────────────────────────────────────

(define-private (is-owner (token-id uint))
  (let ((owner (unwrap! (nft-get-owner? early-eagle token-id) false)))
    (or (is-eq tx-sender owner) (is-eq contract-caller owner))))

(define-public (list-in-ustx (token-id uint) (price uint) (comm <commission-trait>))
  (begin
    (asserts! (is-owner token-id) ERR-NOT-AUTHORIZED)
    (map-set market token-id {
      price:      price,
      commission: (contract-of comm),
      currency:   "STX"
    })
    (print { action: "list-in-ustx", token-id: token-id, price: price })
    (ok true)))

(define-public (unlist-in-ustx (token-id uint))
  (begin
    (asserts! (is-owner token-id) ERR-NOT-AUTHORIZED)
    (map-delete market token-id)
    (print { action: "unlist-in-ustx", token-id: token-id })
    (ok true)))

(define-public (buy-in-ustx (token-id uint) (comm <commission-trait>))
  (let (
    (owner   (unwrap! (nft-get-owner? early-eagle token-id) ERR-NOT-FOUND))
    (listing (unwrap! (map-get? market token-id) ERR-NOT-LISTED))
    (price   (get price listing))
  )
    (asserts! (is-eq (get currency listing) "STX") ERR-WRONG-CURRENCY)
    (asserts! (is-eq (contract-of comm) (get commission listing)) ERR-WRONG-COMMISSION)
    ;; Pay seller
    (try! (stx-transfer? price tx-sender owner))
    ;; Pay royalty (5% from buyer on top, handled by commission contract)
    (try! (contract-call? comm pay token-id price))
    ;; Transfer NFT
    (try! (nft-transfer? early-eagle token-id owner tx-sender))
    (map-delete market token-id)
    (print { action: "buy-in-ustx", token-id: token-id, price: price, buyer: tx-sender, seller: owner })
    (ok true)))

;; ── Marketplace — sBTC ────────────────────────────────────────────────────────

(define-public (list-in-sbtc (token-id uint) (price uint) (comm <commission-trait>))
  (begin
    (asserts! (is-owner token-id) ERR-NOT-AUTHORIZED)
    (map-set market token-id {
      price:      price,
      commission: (contract-of comm),
      currency:   "SBTC"
    })
    (print { action: "list-in-sbtc", token-id: token-id, price: price })
    (ok true)))

(define-public (unlist-in-sbtc (token-id uint))
  (begin
    (asserts! (is-owner token-id) ERR-NOT-AUTHORIZED)
    (map-delete market token-id)
    (print { action: "unlist-in-sbtc", token-id: token-id })
    (ok true)))

(define-public (buy-in-sbtc (token-id uint) (comm <commission-trait>) (sbtc <sip010-trait>))
  (let (
    (owner   (unwrap! (nft-get-owner? early-eagle token-id) ERR-NOT-FOUND))
    (listing (unwrap! (map-get? market token-id) ERR-NOT-LISTED))
    (price   (get price listing))
    (royalty (/ (* price u500) u10000))
  )
    (asserts! (is-eq (get currency listing) "SBTC") ERR-WRONG-CURRENCY)
    (asserts! (is-eq (contract-of comm) (get commission listing)) ERR-WRONG-COMMISSION)
    ;; Verify caller is passing the real sBTC contract, not a fake
    (asserts! (is-eq (contract-of sbtc) SBTC-CONTRACT) ERR-WRONG-TOKEN)
    ;; Pay seller (full price)
    (try! (contract-call? sbtc transfer price tx-sender owner none))
    ;; Pay royalty via commission contract
    (try! (contract-call? comm pay token-id price))
    ;; Transfer NFT
    (try! (nft-transfer? early-eagle token-id owner tx-sender))
    (map-delete market token-id)
    (print { action: "buy-in-sbtc", token-id: token-id, price: price, buyer: tx-sender, seller: owner })
    (ok true)))

;; ── Utils ─────────────────────────────────────────────────────────────────────

;; uint → string-ascii (for token URI construction)
(define-read-only (uint-to-ascii (n uint))
  (get r (fold uint-to-ascii-iter
    (list true true true true true true true true true true true true true true true true true true true true)
    { n: n, r: "" })))

(define-private (uint-to-ascii-iter (ignore bool) (acc { n: uint, r: (string-ascii 40) }))
  (if (> (get n acc) u0)
    {
      n: (/ (get n acc) u10),
      r: (unwrap-panic (as-max-len?
            (concat
              (unwrap-panic (element-at "0123456789" (mod (get n acc) u10)))
              (get r acc))
            u40))
    }
    acc))
