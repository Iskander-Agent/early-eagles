;; Early Eagles
;; SIP-009 NFT — 420 on-chain eagles for Genesis AIBTC agents
;;
;; Mint gate (admin-mint):
;;   1. Admin (CONTRACT-OWNER) broadcasts on behalf of agent (gasless)
;;   2. Agent proves consent via secp256k1 signature — contract recovers
;;      the signer's public key via secp256k1-recover?, derives the
;;      principal via principal-of?, and asserts it equals the recipient
;;   3. ERC-8004 identity verified on-chain via AIBTC registry
;;   4. One mint per wallet (checked on recipient), hard cap 420
;;
;; Marketplace: list/unlist/buy with 2% artist royalty to Iskander
;;
;; Rarity: weighted random draw from remaining tier slots
;;   Legendary:10 Epic:60 Rare:80 Uncommon:150 Common:120

;; ── SIP-009 trait ──────────────────────────────────────────────────────────
(impl-trait 'SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9.nft-trait.nft-trait)

;; ── Constants ──────────────────────────────────────────────────────────────
(define-constant CONTRACT-OWNER tx-sender)

;; Royalty recipient (Early Eagles deploy address — Iskander controls)
(define-constant ARTIST-ADDRESS 'SP35A2J9JBTPSS9WA9XZAPRX8FB3245XXG7CZ0ZM2)

;; Identity registry for ERC-8004 on-chain check
(define-constant IDENTITY-REGISTRY 'SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2)

;; Supply caps
(define-constant MAX-SUPPLY u420)
(define-constant LEGENDARY-CAP u10)
(define-constant EPIC-CAP u60)
(define-constant RARE-CAP u80)
(define-constant UNCOMMON-CAP u150)
(define-constant COMMON-CAP u120)

;; Tier IDs
(define-constant TIER-LEGENDARY u0)
(define-constant TIER-EPIC u1)
(define-constant TIER-RARE u2)
(define-constant TIER-UNCOMMON u3)
(define-constant TIER-COMMON u4)

;; Royalty: 2% = 200 / 10000
(define-constant ROYALTY-NUMERATOR u200)
(define-constant ROYALTY-DENOMINATOR u10000)

;; Errors
(define-constant ERR-NOT-AUTHORIZED (err u401))
(define-constant ERR-ALREADY-MINTED (err u402))
(define-constant ERR-SOLD-OUT (err u403))
(define-constant ERR-INVALID-SIG (err u404))
(define-constant ERR-NO-IDENTITY (err u406))
(define-constant ERR-NONCE-USED (err u407))
(define-constant ERR-NOT-OWNER (err u408))
(define-constant ERR-NOT-LISTED (err u409))
(define-constant ERR-WRONG-PRICE (err u410))
(define-constant ERR-NOT-FOUND (err u411))
(define-constant ERR-RANK-TAKEN (err u413))
(define-constant ERR-MINT-PAUSED (err u414))

;; ── NFT ────────────────────────────────────────────────────────────────────
(define-non-fungible-token early-eagle uint)

;; ── Storage ────────────────────────────────────────────────────────────────
(define-data-var last-token-id uint u0)
(define-data-var total-minted uint u0)
(define-data-var mint-active bool false)

(define-data-var legendary-remaining uint LEGENDARY-CAP)
(define-data-var epic-remaining uint EPIC-CAP)
(define-data-var rare-remaining uint RARE-CAP)
(define-data-var uncommon-remaining uint UNCOMMON-CAP)
(define-data-var common-remaining uint COMMON-CAP)

;; Token traits
(define-map token-traits uint {
  tier: uint,
  color-id: uint,
  agent-id: uint,
  display-name: (string-utf8 64),
  name-ascii: (string-ascii 64),
  btc-address: (string-ascii 62),
  stx-address: principal,
  sigil-seed: (buff 16),
  minted-at: uint
})

;; Marketplace listings: token-id -> {price in uSTX, seller}
(define-map listings uint {
  price: uint,
  seller: principal
})

;; One mint per wallet
(define-map minted-wallets principal bool)

;; Used nonces
(define-map used-nonces (buff 16) bool)

;; Agent rank -> token-id (prevents same agent-id minting twice, even after identity transfer)
(define-map rank-to-token uint uint)

;; ── Color tables ───────────────────────────────────────────────────────────
;; Hue: 0=Azure 1=Sapphire 2=Amethyst 3=Fuchsia 4=Crimson 5=Scarlet
;;      6=Ember 7=Amber 8=Chartreuse 9=Jade 10=Forest 11=Teal
;; FX:  12=Gold 13=Pearl 14=Negative 15=Thermal 16=X-Ray
;;      17=Aurora 18=Psychedelic 19=Infrared 20=Shadow

;; Legendary: 10 x 1-of-1, assigned in mint order
;; idx0=Azure(0) idx1=Gold(12) idx2=Pearl(13) idx3=Negative(14) idx4=Thermal(15)
;; idx5=X-Ray(16) idx6=Aurora(17) idx7=Psychedelic(18) idx8=Infrared(19) idx9=Shadow(20)
(define-read-only (legendary-color-for-index (idx uint))
  (if (is-eq idx u0) u0  (if (is-eq idx u1) u12
  (if (is-eq idx u2) u13 (if (is-eq idx u3) u14
  (if (is-eq idx u4) u15 (if (is-eq idx u5) u16
  (if (is-eq idx u6) u17 (if (is-eq idx u7) u18
  (if (is-eq idx u8) u19 u20)))))))))
)

;; Epic/Rare hue pool (8 colors): Azure Sapphire Fuchsia Crimson Ember Amber Chartreuse Teal
(define-read-only (hue-for-index (idx uint))
  (if (is-eq idx u0) u0  (if (is-eq idx u1) u1
  (if (is-eq idx u2) u3  (if (is-eq idx u3) u4
  (if (is-eq idx u4) u6  (if (is-eq idx u5) u7
  (if (is-eq idx u6) u8  u11)))))))
)

;; Epic: mod seed 60 -> 48 hue slots (8x6) + 12 FX slots (6x2)
;; FX: Pearl(13) Shadow(20) Negative(14) X-Ray(16) Infrared(19) Thermal(15)
(define-read-only (epic-color-for-slot (slot uint))
  (if (< slot u48)
    (hue-for-index (/ slot u6))
    (let ((fx (- slot u48)))
      (if (< fx u2) u13 (if (< fx u4) u20
      (if (< fx u6) u14 (if (< fx u8) u16
      (if (< fx u10) u19 u15)))))))
)

;; Rare: mod seed 80 -> 72 hue slots (8x9) + 8 FX slots
;; FX: Pearl(2) Shadow(2) Negative(1) Thermal(1) X-Ray(1) Infrared(1)
(define-read-only (rare-color-for-slot (slot uint))
  (if (< slot u72)
    (hue-for-index (/ slot u9))
    (let ((fx (- slot u72)))
      (if (< fx u2) u13 (if (< fx u4) u20
      (if (< fx u5) u14 (if (< fx u6) u15
      (if (< fx u7) u16 u19)))))))
)

;; Uncommon/Common: all 12 hues (CIDs 0-11)
(define-read-only (uncommon-color-for-index (idx uint))
  (if (< idx u12) idx u0)
)

;; ── Random seed ────────────────────────────────────────────────────────────
;; Uses get-stacks-block-info? (Clarity 3+) — replaces deprecated get-block-info?.
;; id-header-hash of the previous Stacks block is unpredictable to the caller
;; (committed before the block they appear in), giving us per-mint VRF entropy.
(define-private (get-seed (nonce (buff 16)))
  (buff-to-uint-be
    (sha256 (concat
      (concat
        (unwrap-panic (get-stacks-block-info? id-header-hash (- stacks-block-height u1)))
        (hash160 tx-sender))
      nonce
    ))
  )
)

;; ── Tier draw ──────────────────────────────────────────────────────────────
(define-private (pick-tier (seed uint))
  (let (
    (leg (var-get legendary-remaining))
    (epc (var-get epic-remaining))
    (rar (var-get rare-remaining))
    (unc (var-get uncommon-remaining))
    (com (var-get common-remaining))
    (total (+ leg (+ epc (+ rar (+ unc com)))))
    (roll (mod seed total))
  )
    (if (< roll leg) TIER-LEGENDARY
    (if (< roll (+ leg epc)) TIER-EPIC
    (if (< roll (+ leg (+ epc rar))) TIER-RARE
    (if (< roll (+ leg (+ epc (+ rar unc)))) TIER-UNCOMMON
    TIER-COMMON))))
  )
)

(define-private (pick-color (tier uint) (seed uint) (leg-minted uint))
  (if (is-eq tier TIER-LEGENDARY) (legendary-color-for-index leg-minted)
  (if (is-eq tier TIER-EPIC) (epic-color-for-slot (mod seed u60))
  (if (is-eq tier TIER-RARE) (rare-color-for-slot (mod seed u80))
  (if (is-eq tier TIER-UNCOMMON) (uncommon-color-for-index (mod seed u12))
  (uncommon-color-for-index (mod seed u12))))))
)

;; ── Tier counter helpers ───────────────────────────────────────────────────
(define-private (decrement-tier (tier uint))
  (if (is-eq tier TIER-LEGENDARY) (var-set legendary-remaining (- (var-get legendary-remaining) u1))
  (if (is-eq tier TIER-EPIC)      (var-set epic-remaining      (- (var-get epic-remaining)      u1))
  (if (is-eq tier TIER-RARE)      (var-set rare-remaining      (- (var-get rare-remaining)      u1))
  (if (is-eq tier TIER-UNCOMMON)  (var-set uncommon-remaining  (- (var-get uncommon-remaining)  u1))
                                   (var-set common-remaining    (- (var-get common-remaining)    u1))
  ))))
)

;; ── SIP-009 ────────────────────────────────────────────────────────────────
(define-read-only (get-last-token-id)
  (ok (var-get last-token-id))
)

(define-read-only (get-token-uri (token-id uint))
  (ok none)
)

(define-read-only (get-owner (token-id uint))
  (ok (nft-get-owner? early-eagle token-id))
)

(define-public (transfer (token-id uint) (sender principal) (recipient principal))
  (begin
    (asserts! (is-eq tx-sender sender) ERR-NOT-OWNER)
    (asserts! (is-none (map-get? listings token-id)) ERR-NOT-AUTHORIZED) ;; must unlist first
    (nft-transfer? early-eagle token-id sender recipient)
  )
)

;; ── Marketplace ────────────────────────────────────────────────────────────

;; List for sale at price in uSTX
(define-public (list-for-sale (token-id uint) (price uint))
  (let ((owner (unwrap! (nft-get-owner? early-eagle token-id) ERR-NOT-FOUND)))
    (asserts! (is-eq tx-sender owner) ERR-NOT-OWNER)
    (asserts! (>= price u1000) ERR-WRONG-PRICE) ;; min 0.001 STX — prevents zero-royalty buy revert
    (map-set listings token-id { price: price, seller: tx-sender })
    (ok true)
  )
)

;; Remove listing
(define-public (unlist (token-id uint))
  (let ((listing (unwrap! (map-get? listings token-id) ERR-NOT-LISTED)))
    (asserts! (is-eq tx-sender (get seller listing)) ERR-NOT-OWNER)
    (map-delete listings token-id)
    (ok true)
  )
)

;; Buy a listed NFT
;; Buyer sends STX; 2% goes to artist, remainder to seller
(define-public (buy (token-id uint))
  (let (
    (listing (unwrap! (map-get? listings token-id) ERR-NOT-LISTED))
    (price (get price listing))
    (seller (get seller listing))
    (royalty (/ (* price ROYALTY-NUMERATOR) ROYALTY-DENOMINATOR))
    (seller-proceeds (- price royalty))
  )
    ;; Pay artist royalty
    (try! (stx-transfer? royalty tx-sender ARTIST-ADDRESS))
    ;; Pay seller
    (try! (stx-transfer? seller-proceeds tx-sender seller))
    ;; Remove listing
    (map-delete listings token-id)
    ;; Transfer NFT
    (try! (nft-transfer? early-eagle token-id seller tx-sender))
    (ok true)
  )
)

;; Read listing
(define-read-only (get-listing (token-id uint))
  (map-get? listings token-id)
)

;; ── Mint controls ──────────────────────────────────────────────────────────
(define-public (start-mint)
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-AUTHORIZED)
    (var-set mint-active true)
    (ok true)))

(define-public (pause-mint)
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-AUTHORIZED)
    (var-set mint-active false)
    (ok true)))

(define-read-only (is-mint-active) (var-get mint-active))

;; ── Premint (founding eagles — admin airdrops with specified tier+color) ───
;; No signature needed. Admin specifies recipient, tier, color directly.
;; Identity owner check still applies — recipient must own the agent-id.
(define-public (premint
    (recipient principal)
    (agent-id uint)
    (display-name (string-utf8 64))
    (name-ascii (string-ascii 64))
    (btc-addr (string-ascii 62))
    (tier uint)
    (color-id uint))
  (let (
    (total (var-get total-minted))
    (token-id total)
  )
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-AUTHORIZED)
    (asserts! (< total MAX-SUPPLY) ERR-SOLD-OUT)
    (asserts! (is-none (map-get? minted-wallets recipient)) ERR-ALREADY-MINTED)
    (asserts! (is-none (map-get? rank-to-token agent-id)) ERR-RANK-TAKEN)
    ;; Verify recipient owns this agent-id in the ERC-8004 registry
    (asserts!
      (is-eq
        (unwrap! (unwrap-panic (contract-call? IDENTITY-REGISTRY get-owner agent-id)) ERR-NO-IDENTITY)
        recipient)
      ERR-NOT-AUTHORIZED)
    (decrement-tier tier)
    (try! (nft-mint? early-eagle token-id recipient))
    (map-set token-traits token-id {
      tier: tier,
      color-id: color-id,
      agent-id: agent-id,
      display-name: display-name,
      name-ascii: name-ascii,
      btc-address: btc-addr,
      stx-address: recipient,
      sigil-seed: 0x00000000000000000000000000000000,
      minted-at: stacks-block-height
    })
    (map-set minted-wallets recipient true)
    (map-set rank-to-token agent-id token-id)
    (var-set total-minted (+ total u1))
    (var-set last-token-id token-id)
    (ok token-id)
  )
)

;; ── Admin mint (gasless, agent-consent-verified) ─────────────────────────────
;; Admin broadcasts on behalf of agent. Agent proves consent via signature.
;; Signature message: keccak256(to-consensus-buff?(recipient) || nonce || expiry-buff)
;; Contract recovers the signer's pubkey and verifies principal-of? == recipient.
;; This guarantees only the agent's own private key can authorize their mint.
(define-public (admin-mint
    (recipient principal)
    (nonce (buff 16))
    (expiry-buff (buff 8))
    (agent-sig (buff 65))
    (agent-id uint)
    (display-name (string-utf8 64))
    (name-ascii (string-ascii 64))
    (btc-addr (string-ascii 62)))
  (let (
    (total (var-get total-minted))
    (token-id total)
    ;; Recover signer from agent's signature
    (msg-hash (keccak256 (concat
      (concat (unwrap-panic (to-consensus-buff? recipient)) nonce)
      expiry-buff
    )))
    (recovered-key (unwrap! (secp256k1-recover? msg-hash agent-sig) ERR-INVALID-SIG))
    (signer-addr (unwrap! (principal-of? recovered-key) ERR-INVALID-SIG))
  )
    ;; 1. Admin only
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-AUTHORIZED)

    ;; 2. Mint must be active (start-mint called after premints)
    (asserts! (var-get mint-active) ERR-MINT-PAUSED)

    ;; 3. Supply cap
    (asserts! (< total MAX-SUPPLY) ERR-SOLD-OUT)

    ;; 4. One per wallet (checked on recipient, not admin)
    (asserts! (is-none (map-get? minted-wallets recipient)) ERR-ALREADY-MINTED)

    ;; 5. Nonce not reused
    (asserts! (is-none (map-get? used-nonces nonce)) ERR-NONCE-USED)

    ;; 6. Agent consent — recovered signer must equal recipient
    (asserts! (is-eq signer-addr recipient) ERR-INVALID-SIG)

    ;; 7. Verify ERC-8004 identity on-chain: owner of agent-id MUST be the recipient
    (asserts!
      (is-eq
        (unwrap! (unwrap-panic (contract-call? IDENTITY-REGISTRY get-owner agent-id)) ERR-NO-IDENTITY)
        recipient)
      ERR-NOT-AUTHORIZED)

    ;; 8. Same agent rank can only mint once (even if identity is transferred)
    (asserts! (is-none (map-get? rank-to-token agent-id)) ERR-RANK-TAKEN)

    ;; 9. Random tier + color
    (let (
      (seed (get-seed nonce))
      (tier (pick-tier seed))
      (leg-so-far (- LEGENDARY-CAP (var-get legendary-remaining)))
      (color (pick-color tier (xor seed stacks-block-height) leg-so-far))
    )
      (decrement-tier tier)
      (try! (nft-mint? early-eagle token-id recipient))
      (map-set token-traits token-id {
        tier: tier,
        color-id: color,
        agent-id: agent-id,
        display-name: display-name,
        name-ascii: name-ascii,
        btc-address: btc-addr,
        stx-address: recipient,
        sigil-seed: nonce,
        minted-at: stacks-block-height
      })
      (map-set minted-wallets recipient true)
      (map-set used-nonces nonce true)
      (map-set rank-to-token agent-id token-id)
      (var-set total-minted (+ total u1))
      (var-set last-token-id token-id)
      (ok token-id)
    )
  )
)

;; ── Render params (on-chain JSON for card rendering) ──────────────────────
;; Returns JSON: {"rank":N,"tier":N,"cid":N,"name":"...","btc":"..."}
;; Pass to renderer contract get-card-html to assemble full HTML card.
(define-read-only (get-render-params (token-id uint))
  (match (map-get? token-traits token-id)
    traits
      (ok (concat (concat (concat (concat (concat (concat (concat (concat (concat (concat
        "{\"rank\":" (uint-to-ascii (get agent-id traits)))
        ",\"tier\":") (uint-to-ascii (get tier traits)))
        ",\"cid\":") (uint-to-ascii (get color-id traits)))
        ",\"name\":\"") (get name-ascii traits))
        "\",\"btc\":\"") (get btc-address traits))
        "\"}"))
    (err ERR-NOT-FOUND)))

;; ── Read helpers ───────────────────────────────────────────────────────────
(define-read-only (get-traits (token-id uint))
  (map-get? token-traits token-id)
)

(define-read-only (get-mint-stats)
  {
    total-minted: (var-get total-minted),
    legendary-remaining: (var-get legendary-remaining),
    epic-remaining: (var-get epic-remaining),
    rare-remaining: (var-get rare-remaining),
    uncommon-remaining: (var-get uncommon-remaining),
    common-remaining: (var-get common-remaining)
  }
)

(define-read-only (has-minted (wallet principal))
  (default-to false (map-get? minted-wallets wallet))
)

(define-read-only (get-token-for-rank (agent-id uint))
  (map-get? rank-to-token agent-id)
)

(define-read-only (get-royalty-info)
  { artist: ARTIST-ADDRESS, numerator: ROYALTY-NUMERATOR, denominator: ROYALTY-DENOMINATOR }
)

;; ── Single digit to ASCII ───────────────────────────────────────────────────
(define-read-only (digit-to-ascii (d uint))
  (if (is-eq d u0) "0" (if (is-eq d u1) "1" (if (is-eq d u2) "2"
  (if (is-eq d u3) "3" (if (is-eq d u4) "4" (if (is-eq d u5) "5"
  (if (is-eq d u6) "6" (if (is-eq d u7) "7" (if (is-eq d u8) "8"
  "9")))))))))
)

;; ── uint-to-ascii (covers 0-99999) ───────────────────────────────────────────
(define-read-only (uint-to-ascii (n uint))
  (let (
    (d4 (/ n u10000))
    (d3 (/ (mod n u10000) u1000))
    (d2 (/ (mod n u1000) u100))
    (d1 (/ (mod n u100) u10))
    (d0 (mod n u10))
  )
    (if (> d4 u0)
      (concat (concat (concat (concat (digit-to-ascii d4) (digit-to-ascii d3)) (digit-to-ascii d2)) (digit-to-ascii d1)) (digit-to-ascii d0))
      (if (> d3 u0)
        (concat (concat (concat (digit-to-ascii d3) (digit-to-ascii d2)) (digit-to-ascii d1)) (digit-to-ascii d0))
        (if (> d2 u0)
          (concat (concat (digit-to-ascii d2) (digit-to-ascii d1)) (digit-to-ascii d0))
          (if (> d1 u0)
            (concat (digit-to-ascii d1) (digit-to-ascii d0))
            (digit-to-ascii d0)
          )
        )
      )
    )
  )
)
