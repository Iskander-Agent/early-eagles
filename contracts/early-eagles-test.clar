;; Early Eagles TEST CONTRACT
;; Identical to production EXCEPT:
;; 1. No SIP-009 trait impl (not needed for testing)
;; 2. No ERC-8004 identity check (lets anyone mint for testing)
;; 3. Admin can call test-mint to simulate mints without sig check
;; 4. Admin can reset state for re-testing
;;
;; Deploy as: early-eagles-test-v0 (or v1, v2 etc)

;; -- Constants --
(define-constant CONTRACT-OWNER tx-sender)
(define-constant ARTIST-ADDRESS 'SP3JR7JXFT7ZM9JKSQPBQG1HPT0D365MA5TN0P12E)

;; Signer pubkey (same as production)
(define-constant SIGNER-PUBKEY 0x02c53878712b84cf60944b04119d3e08a802ccb549b71369314e3512f86b942c31)

(define-constant MAX-SUPPLY u210)
(define-constant LEGENDARY-CAP u10)
(define-constant EPIC-CAP u30)
(define-constant RARE-CAP u40)
(define-constant UNCOMMON-CAP u70)
(define-constant COMMON-CAP u60)

(define-constant TIER-LEGENDARY u0)
(define-constant TIER-EPIC u1)
(define-constant TIER-RARE u2)
(define-constant TIER-UNCOMMON u3)
(define-constant TIER-COMMON u4)

(define-constant ROYALTY-NUMERATOR u200)
(define-constant ROYALTY-DENOMINATOR u10000)

(define-constant ERR-NOT-AUTHORIZED (err u401))
(define-constant ERR-ALREADY-MINTED (err u402))
(define-constant ERR-SOLD-OUT (err u403))
(define-constant ERR-INVALID-SIG (err u404))
(define-constant ERR-SIG-EXPIRED (err u405))
(define-constant ERR-NONCE-USED (err u407))
(define-constant ERR-NOT-OWNER (err u408))
(define-constant ERR-NOT-LISTED (err u409))
(define-constant ERR-WRONG-PRICE (err u410))
(define-constant ERR-NOT-FOUND (err u411))
(define-constant ERR-RESERVE-DONE (err u412))

;; -- NFT --
(define-non-fungible-token early-eagle uint)

;; -- Storage --
(define-data-var last-token-id uint u0)
(define-data-var total-minted uint u0)
(define-data-var reserve-done bool false)

(define-data-var legendary-remaining uint LEGENDARY-CAP)
(define-data-var epic-remaining uint EPIC-CAP)
(define-data-var rare-remaining uint RARE-CAP)
(define-data-var uncommon-remaining uint UNCOMMON-CAP)
(define-data-var common-remaining uint COMMON-CAP)

(define-map token-traits uint {
  tier: uint,
  color-id: uint,
  agent-id: uint,
  display-name: (string-utf8 64),
  btc-address: (string-ascii 62),
  stx-address: principal,
  sigil-seed: (buff 16),
  minted-at: uint
})

(define-map listings uint { price: uint, seller: principal })
(define-map minted-wallets principal bool)
(define-map used-nonces (buff 16) bool)

;; -- Color tables --
(define-read-only (legendary-color-for-index (idx uint))
  (if (is-eq idx u0) u12 (if (is-eq idx u1) u18
  (if (is-eq idx u2) u19 (if (is-eq idx u3) u20
  (if (is-eq idx u4) u17 (if (is-eq idx u5) u16
  (if (is-eq idx u6) u14 (if (is-eq idx u7) u15
  (if (is-eq idx u8) u13 u0)))))))))
)

(define-read-only (epic-color-for-index (idx uint))
  (if (is-eq idx u0) u0 (if (is-eq idx u1) u1
  (if (is-eq idx u2) u3 (if (is-eq idx u3) u4
  (if (is-eq idx u4) u13 (if (is-eq idx u5) u6
  (if (is-eq idx u6) u7 (if (is-eq idx u7) u8
  (if (is-eq idx u8) u10 u15)))))))))
)

(define-read-only (uncommon-color-for-index (idx uint))
  (if (is-eq idx u0) u0 (if (is-eq idx u1) u1
  (if (is-eq idx u2) u2 (if (is-eq idx u3) u3
  (if (is-eq idx u4) u4 (if (is-eq idx u5) u5
  (if (is-eq idx u6) u6 (if (is-eq idx u7) u7
  (if (is-eq idx u8) u8 (if (is-eq idx u9) u9
  (if (is-eq idx u10) u10 u11)))))))))))
)

;; -- Random --
(define-private (get-seed (nonce (buff 16)))
  (buff-to-uint-be
    (sha256 (concat
      (unwrap-panic (get-block-info? id-header-hash (- stacks-block-height u1)))
      (hash160 tx-sender)
      nonce
    ))
  )
)

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
  (if (is-eq tier TIER-EPIC) (epic-color-for-index (mod seed u10))
  (if (is-eq tier TIER-RARE) (epic-color-for-index (mod seed u10))
  (if (is-eq tier TIER-UNCOMMON) (uncommon-color-for-index (mod seed u12))
  (uncommon-color-for-index (mod seed u12))))))
)

(define-private (decrement-tier (tier uint))
  (if (is-eq tier TIER-LEGENDARY) (var-set legendary-remaining (- (var-get legendary-remaining) u1))
  (if (is-eq tier TIER-EPIC)      (var-set epic-remaining      (- (var-get epic-remaining)      u1))
  (if (is-eq tier TIER-RARE)      (var-set rare-remaining      (- (var-get rare-remaining)      u1))
  (if (is-eq tier TIER-UNCOMMON)  (var-set uncommon-remaining  (- (var-get uncommon-remaining)  u1))
                                   (var-set common-remaining    (- (var-get common-remaining)    u1))
  ))))
)

;; -- Sig verification (same as production) --
(define-private (verify-sig
    (nonce (buff 16))
    (expiry-buff (buff 8))
    (signature (buff 65)))
  (let (
    (msg-hash (keccak256 (concat
      (concat (unwrap-panic (to-consensus-buff? tx-sender)) nonce)
      expiry-buff
    )))
    (recovered (unwrap! (secp256k1-recover? msg-hash signature) (err u404)))
  )
    (asserts! (is-eq recovered SIGNER-PUBKEY) (err u404))
    (ok true)
  )
)

;; -- SIP-009 --
(define-read-only (get-last-token-id)
  (ok (var-get last-token-id))
)

(define-read-only (get-token-uri (token-id uint))
  (ok (some "https://early-eagles.vercel.app/api/token/"))
)

(define-read-only (get-owner (token-id uint))
  (ok (nft-get-owner? early-eagle token-id))
)

(define-public (transfer (token-id uint) (sender principal) (recipient principal))
  (begin
    (asserts! (is-eq tx-sender sender) ERR-NOT-OWNER)
    (asserts! (is-none (map-get? listings token-id)) ERR-NOT-AUTHORIZED)
    (nft-transfer? early-eagle token-id sender recipient)
  )
)

;; -- Marketplace --
(define-public (list-for-sale (token-id uint) (price uint))
  (let ((owner (unwrap! (nft-get-owner? early-eagle token-id) ERR-NOT-FOUND)))
    (asserts! (is-eq tx-sender owner) ERR-NOT-OWNER)
    (asserts! (> price u0) ERR-WRONG-PRICE)
    (map-set listings token-id { price: price, seller: tx-sender })
    (ok true)
  )
)

(define-public (unlist (token-id uint))
  (let ((listing (unwrap! (map-get? listings token-id) ERR-NOT-LISTED)))
    (asserts! (is-eq tx-sender (get seller listing)) ERR-NOT-OWNER)
    (map-delete listings token-id)
    (ok true)
  )
)

(define-public (buy (token-id uint))
  (let (
    (listing (unwrap! (map-get? listings token-id) ERR-NOT-LISTED))
    (price (get price listing))
    (seller (get seller listing))
    (royalty (/ (* price ROYALTY-NUMERATOR) ROYALTY-DENOMINATOR))
    (seller-proceeds (- price royalty))
  )
    (try! (stx-transfer? royalty tx-sender ARTIST-ADDRESS))
    (try! (stx-transfer? seller-proceeds tx-sender seller))
    (map-delete listings token-id)
    (try! (nft-transfer? early-eagle token-id seller tx-sender))
    (ok true)
  )
)

(define-read-only (get-listing (token-id uint))
  (map-get? listings token-id)
)

;; -- Reserve mint (Iskander #0) --
(define-public (reserve-iskander
    (display-name (string-utf8 64))
    (btc-addr (string-ascii 62))
    (agent-id uint))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-AUTHORIZED)
    (asserts! (not (var-get reserve-done)) ERR-RESERVE-DONE)
    (try! (nft-mint? early-eagle u0 tx-sender))
    (map-set token-traits u0 {
      tier: TIER-LEGENDARY,
      color-id: u0,
      agent-id: agent-id,
      display-name: display-name,
      btc-address: btc-addr,
      stx-address: tx-sender,
      sigil-seed: 0x00000000000000000000000000000000,
      minted-at: stacks-block-height
    })
    (map-set minted-wallets tx-sender true)
    (var-set legendary-remaining (- (var-get legendary-remaining) u1))
    (var-set total-minted u1)
    (var-set last-token-id u0)
    (var-set reserve-done true)
    (ok u0)
  )
)

;; -- Public mint (with backend sig, NO identity check for test) --
(define-public (mint
    (nonce (buff 16))
    (expiry-buff (buff 8))
    (signature (buff 65))
    (agent-id uint)
    (display-name (string-utf8 64))
    (btc-addr (string-ascii 62)))
  (let (
    (caller tx-sender)
    (total (var-get total-minted))
    (token-id (+ total u1))
  )
    (asserts! (< total MAX-SUPPLY) ERR-SOLD-OUT)
    (asserts! (is-none (map-get? minted-wallets caller)) ERR-ALREADY-MINTED)
    (asserts! (is-none (map-get? used-nonces nonce)) ERR-NONCE-USED)
    (try! (verify-sig nonce expiry-buff signature))

    ;; NO identity check in test contract

    (let (
      (seed (get-seed nonce))
      (tier (pick-tier seed))
      (leg-so-far (- LEGENDARY-CAP (var-get legendary-remaining)))
      (color (pick-color tier (xor seed stacks-block-height) leg-so-far))
    )
      (decrement-tier tier)
      (try! (nft-mint? early-eagle token-id caller))
      (map-set token-traits token-id {
        tier: tier, color-id: color, agent-id: agent-id,
        display-name: display-name, btc-address: btc-addr,
        stx-address: caller, sigil-seed: nonce,
        minted-at: stacks-block-height
      })
      (map-set minted-wallets caller true)
      (map-set used-nonces nonce true)
      (var-set total-minted (+ total u1))
      (var-set last-token-id token-id)
      (ok token-id)
    )
  )
)

;; ============================================================
;; TEST-ONLY FUNCTIONS (not in production contract)
;; ============================================================

;; Admin direct mint: skip sig check entirely, mint with chosen traits
(define-public (test-mint
    (recipient principal)
    (display-name (string-utf8 64))
    (btc-addr (string-ascii 62))
    (agent-id uint))
  (let (
    (total (var-get total-minted))
    (token-id (if (var-get reserve-done) (+ total u1) total))
    (nonce-buf (unwrap-panic (as-max-len? (sha256 (unwrap-panic (to-consensus-buff? total))) u16)))
    (seed (buff-to-uint-be (sha256 (concat
      (unwrap-panic (get-block-info? id-header-hash (- stacks-block-height u1)))
      (unwrap-panic (to-consensus-buff? total))
    ))))
    (tier (pick-tier seed))
    (leg-so-far (- LEGENDARY-CAP (var-get legendary-remaining)))
    (color (pick-color tier (xor seed stacks-block-height) leg-so-far))
  )
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-AUTHORIZED)
    (asserts! (< total MAX-SUPPLY) ERR-SOLD-OUT)
    (decrement-tier tier)
    (try! (nft-mint? early-eagle token-id recipient))
    (map-set token-traits token-id {
      tier: tier, color-id: color, agent-id: agent-id,
      display-name: display-name, btc-address: btc-addr,
      stx-address: recipient, sigil-seed: nonce-buf,
      minted-at: stacks-block-height
    })
    (var-set total-minted (+ total u1))
    (var-set last-token-id token-id)
    (ok { token-id: token-id, tier: tier, color-id: color })
  )
)

;; Admin batch mint: mint N tokens to same address for rapid testing
(define-public (test-batch-mint-5
    (recipient principal)
    (name (string-utf8 64))
    (btc (string-ascii 62)))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-AUTHORIZED)
    (try! (test-mint recipient name btc u1))
    (try! (test-mint recipient name btc u2))
    (try! (test-mint recipient name btc u3))
    (try! (test-mint recipient name btc u4))
    (try! (test-mint recipient name btc u5))
    (ok true)
  )
)

;; -- Read helpers --
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

(define-read-only (get-royalty-info)
  { artist: ARTIST-ADDRESS, numerator: ROYALTY-NUMERATOR, denominator: ROYALTY-DENOMINATOR }
)
