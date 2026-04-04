;; early-eagles-v2-testnet.clar
;; TESTNET VERSION -- Phase 1 test deploy
;;
;; Changes from mainnet (early-eagles-v2.clar):
;;   - nft-trait: ST1NXBK3K5YYMD6FD41MVNP3JS1GABZ8TRVX023PT (testnet)
;;   - sip010-trait: ST1NXBK3K5YYMD6FD41MVNP3JS1GABZ8TRVX023PT (testnet)
;;   - SBTC-CONTRACT: STV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RJ5XDY2.sbtc-token (testnet, has faucet)
;;   - Agent gating: replaced with owner-bypass (no AIBTC registry on testnet)
;;   - Added: test-claim (owner-only, no gating) for Phase 1 testing

;; -- Traits --------------------------------------------------------------------

(impl-trait 'ST1NXBK3K5YYMD6FD41MVNP3JS1GABZ8TRVX023PT.nft-trait.nft-trait)
(use-trait commission-trait .commission-trait.commission)
(use-trait sip010-trait 'ST1NXBK3K5YYMD6FD41MVNP3JS1GABZ8TRVX023PT.sip-010-trait-ft-standard.sip-010-trait)

;; -- NFT Definition -------------------------------------------------------------

(define-non-fungible-token early-eagle uint)

;; -- Constants ------------------------------------------------------------------

(define-constant CONTRACT-OWNER tx-sender)
(define-constant MAX-SUPPLY u210)

;; Testnet sBTC (has faucet function)
(define-constant SBTC-CONTRACT 'STV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RJ5XDY2.sbtc-token)

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
(define-constant ERR-RANK-TAKEN        (err u308))

;; -- Storage -------------------------------------------------------------------

(define-data-var total-minted uint u0)

;; On-chain traits per token
(define-map token-traits uint {
  tier:         uint,           ;; 0=Legendary 1=Epic 2=Rare 3=Uncommon 4=Common
  color-id:     uint,           ;; 0-20, see color table
  agent-id:     uint,           ;; AIBTC agent rank (1-210)
  display-name: (string-utf8 64),
  name-ascii:   (string-ascii 64),  ;; ASCII copy frozen at mint for on-chain rendering
  btc-address:  (string-ascii 62),
  stx-address:  principal,
  sigil-seed:   (buff 16),
  minted-at:    uint
})

;; rank -> token-id (prevents double-claiming a rank)
(define-map rank-to-token uint uint)

;; Marketplace listings
(define-map market uint {
  price:      uint,
  commission: principal,
  currency:   (string-ascii 4)  ;; "STX" or "SBTC"
})

;; -- SIP-009 Required Functions ------------------------------------------------

(define-read-only (get-last-token-id)
  (ok (var-get total-minted)))

(define-read-only (get-owner (token-id uint))
  (ok (nft-get-owner? early-eagle token-id)))

(define-read-only (get-token-uri (token-id uint))
  (ok (some (concat
    "https://early-eagles-testnet.vercel.app/api/token/"
    (uint-to-ascii token-id)))))

;; Returns the renderer-ready JSON string for a token.
;; name-ascii is frozen at mint -- survives all trades, owner changes nothing.
(define-read-only (get-render-params (token-id uint))
  (match (map-get? token-traits token-id)
    traits
      (let (
        (p1 (unwrap-panic (as-max-len? (concat "{\"rank\":" (uint-to-ascii (get agent-id traits)))  u64)))
        (p2 (unwrap-panic (as-max-len? (concat p1 ",\"cid\":")                                      u72)))
        (p3 (unwrap-panic (as-max-len? (concat p2 (uint-to-ascii (get color-id traits)))             u112)))
        (p4 (unwrap-panic (as-max-len? (concat p3 ",\"tier\":")                                     u121)))
        (p5 (unwrap-panic (as-max-len? (concat p4 (uint-to-ascii (get tier traits)))                 u161)))
        (p6 (unwrap-panic (as-max-len? (concat p5 ",\"name\":\"")                                   u171)))
        (p7 (unwrap-panic (as-max-len? (concat p6 (get name-ascii traits))                           u235)))
        (p8 (unwrap-panic (as-max-len? (concat p7 "\",\"btc\":\"")                                   u244)))
        (p9 (unwrap-panic (as-max-len? (concat p8 (get btc-address traits))                          u306)))
        (p10 (unwrap-panic (as-max-len? (concat p9 "\"}")
                           u308)))
      )
        (ok p10))
    (err u404)))

(define-public (transfer (token-id uint) (sender principal) (recipient principal))
  (begin
    (asserts! (is-eq tx-sender sender) ERR-NOT-AUTHORIZED)
    ;; Block transfer if listed -- must unlist first
    (asserts! (is-none (map-get? market token-id)) ERR-LISTING)
    (nft-transfer? early-eagle token-id sender recipient)))

;; -- Read Helpers --------------------------------------------------------------

(define-read-only (get-traits (token-id uint))
  (map-get? token-traits token-id))

(define-read-only (get-listing (token-id uint))
  (map-get? market token-id))

(define-read-only (get-token-for-rank (rank uint))
  (map-get? rank-to-token rank))

(define-read-only (get-mint-stats)
  { total-minted: (var-get total-minted), max-supply: MAX-SUPPLY })

;; -- Minting (TESTNET: owner-bypass, no AIBTC registry) ------------------------

;; Testnet: any principal can claim any rank (owner auth only, no registry check).
;; Used for Phase 1 testing. Mainnet version checks AIBTC identity registry.
(define-public (claim
    (agent-id uint)
    (display-name (string-utf8 64))
    (name-ascii (string-ascii 64))
    (btc-addr (string-ascii 62))
    (tier uint)
    (color-id uint)
    (sigil-seed (buff 16)))
  (let ((token-id (var-get total-minted)))
    (asserts! (<= token-id MAX-SUPPLY) ERR-SOLD-OUT)
    (asserts! (is-none (map-get? rank-to-token agent-id)) ERR-RANK-TAKEN)
    ;; TESTNET: no registry check -- any caller can claim
    (try! (nft-mint? early-eagle token-id tx-sender))
    (map-set token-traits token-id {
      tier:         tier,
      color-id:     color-id,
      agent-id:     agent-id,
      display-name: display-name,
      name-ascii:   name-ascii,
      btc-address:  btc-addr,
      stx-address:  tx-sender,
      sigil-seed:   sigil-seed,
      minted-at:    stacks-block-height
    })
    (map-set rank-to-token agent-id token-id)
    (var-set total-minted (+ token-id u1))
    (ok { token-id: token-id })))

;; Owner-only: airdrop mint for initial distribution
(define-public (airdrop-mint
    (recipient principal)
    (agent-id uint)
    (display-name (string-utf8 64))
    (name-ascii (string-ascii 64))
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
      name-ascii:   name-ascii,
      btc-address:  btc-addr,
      stx-address:  recipient,
      sigil-seed:   sigil-seed,
      minted-at:    stacks-block-height
    })
    (map-set rank-to-token agent-id token-id)
    (var-set total-minted (+ token-id u1))
    (ok { token-id: token-id })))

;; -- Marketplace -- STX ---------------------------------------------------------

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
    (try! (stx-transfer? price tx-sender owner))
    (try! (contract-call? comm pay token-id price))
    (try! (nft-transfer? early-eagle token-id owner tx-sender))
    (map-delete market token-id)
    (print { action: "buy-in-ustx", token-id: token-id, price: price, buyer: tx-sender, seller: owner })
    (ok true)))

;; -- Marketplace -- sBTC --------------------------------------------------------

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
  )
    (asserts! (is-eq (get currency listing) "SBTC") ERR-WRONG-CURRENCY)
    (asserts! (is-eq (contract-of comm) (get commission listing)) ERR-WRONG-COMMISSION)
    (asserts! (is-eq (contract-of sbtc) SBTC-CONTRACT) ERR-WRONG-TOKEN)
    (try! (contract-call? sbtc transfer price tx-sender owner none))
    (try! (contract-call? comm pay token-id price))
    (try! (nft-transfer? early-eagle token-id owner tx-sender))
    (map-delete market token-id)
    (print { action: "buy-in-sbtc", token-id: token-id, price: price, buyer: tx-sender, seller: owner })
    (ok true)))

;; -- Utils ---------------------------------------------------------------------

(define-read-only (uint-to-ascii (n uint))
  (let ((raw (get r (fold uint-to-ascii-iter
    (list true true true true true true true true true true true true true true true true true true true true)
    { n: n, r: "" }))))
    (if (is-eq raw "") "0" raw)))

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
