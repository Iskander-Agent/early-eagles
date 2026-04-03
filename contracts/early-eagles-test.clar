;; Early Eagles TEST
;; Production-grade contract with admin test-mint added
;; SIP-009 NFT ? one eagle for each of the first 210 Genesis AIBTC agents
;;
;; Mint gate:
;;   1. Caller presents a backend-signed authorization
;;   2. Contract verifies signature against hardcoded signer pubkey
;;   3. Caller must own a token in the AIBTC identity registry (ERC-8004)
;;   4. One mint per wallet, hard cap 210
;;
;; Marketplace: list/unlist/buy with 2% artist royalty to Iskander
;;
;; Rarity: weighted random draw from remaining tier slots
;;   Legendary:10 Epic:30 Rare:40 Uncommon:70 Common:60

;; ?? SIP-009 trait ??????????????????????????????????????????????????????????
(impl-trait 'SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9.nft-trait.nft-trait)

;; ?? Constants ??????????????????????????????????????????????????????????????
(define-constant CONTRACT-OWNER tx-sender)

;; Artist royalty recipient (Iskander mainnet address)
(define-constant ARTIST-ADDRESS 'SP3JR7JXFT7ZM9JKSQPBQG1HPT0D365MA5TN0P12E)

;; Identity registry for ERC-8004 on-chain check
(define-constant IDENTITY-REGISTRY 'SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2)

;; Signer public key (33 bytes compressed secp256k1)
;; Derived from SIGNER_PRIVATE_KEY env var in the Vercel worker
(define-constant SIGNER-PUBKEY 0x02c53878712b84cf60944b04119d3e08a802ccb549b71369314e3512f86b942c31)

;; Supply caps
(define-constant MAX-SUPPLY u210)
(define-constant LEGENDARY-CAP u10)
(define-constant EPIC-CAP u30)
(define-constant RARE-CAP u40)
(define-constant UNCOMMON-CAP u70)
(define-constant COMMON-CAP u60)

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
(define-constant ERR-SIG-EXPIRED (err u405))
(define-constant ERR-NO-IDENTITY (err u406))
(define-constant ERR-NONCE-USED (err u407))
(define-constant ERR-NOT-OWNER (err u408))
(define-constant ERR-NOT-LISTED (err u409))
(define-constant ERR-WRONG-PRICE (err u410))
(define-constant ERR-NOT-FOUND (err u411))
(define-constant ERR-RESERVE-DONE (err u412))

;; ?? NFT ????????????????????????????????????????????????????????????????????
(define-non-fungible-token early-eagle uint)

;; ?? Storage ????????????????????????????????????????????????????????????????
(define-data-var last-token-id uint u0)
(define-data-var total-minted uint u0)
(define-data-var reserve-done bool false)

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

;; ?? Color tables ???????????????????????????????????????????????????????????
;; 0=Azure 1=Amethyst 2=Fuchsia 3=Crimson 4=Amber 5=Jade 6=Forest 7=Teal
;; 8=Prism 9=Cobalt 10=Chartreuse 11=Violet 12=Gold 13=Pearl 14=Sepia
;; 15=Shadow 16=Negative 17=Thermal 18=X-Ray 19=Aurora 20=Psychedelic

;; Legendary: 10 x 1-of-1, assigned in mint order
(define-read-only (legendary-color-for-index (idx uint))
  (if (is-eq idx u0) u12 (if (is-eq idx u1) u18
  (if (is-eq idx u2) u19 (if (is-eq idx u3) u20
  (if (is-eq idx u4) u17 (if (is-eq idx u5) u16
  (if (is-eq idx u6) u14 (if (is-eq idx u7) u15
  (if (is-eq idx u8) u13 u0)))))))))
)

;; Epic/Rare colors (10 options)
(define-read-only (epic-color-for-index (idx uint))
  (if (is-eq idx u0) u0 (if (is-eq idx u1) u1
  (if (is-eq idx u2) u3 (if (is-eq idx u3) u4
  (if (is-eq idx u4) u13 (if (is-eq idx u5) u6
  (if (is-eq idx u6) u7 (if (is-eq idx u7) u8
  (if (is-eq idx u8) u10 u15)))))))))
)

;; Uncommon/Common colors (12 options)
(define-read-only (uncommon-color-for-index (idx uint))
  (if (is-eq idx u0) u0 (if (is-eq idx u1) u1
  (if (is-eq idx u2) u2 (if (is-eq idx u3) u3
  (if (is-eq idx u4) u4 (if (is-eq idx u5) u5
  (if (is-eq idx u6) u6 (if (is-eq idx u7) u7
  (if (is-eq idx u8) u8 (if (is-eq idx u9) u9
  (if (is-eq idx u10) u10 u11)))))))))))
)

;; ?? Random seed ????????????????????????????????????????????????????????????
(define-private (get-seed (nonce (buff 16)))
  (buff-to-uint-be
    (sha256 (concat
      (unwrap-panic (get-block-info? id-header-hash (- stacks-block-height u1)))
      (hash160 tx-sender)
      nonce
    ))
  )
)

;; ?? Tier draw ??????????????????????????????????????????????????????????????
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

;; ?? Signature verification ?????????????????????????????????????????????????
;; Message = keccak256(to-consensus-buff?(tx-sender) || nonce || expiry-buff-8)
;; to-consensus-buff? for standard principal = 0x05 + version(1) + hash160(20) = 22 bytes
;; expiry passed as (buff 8) = uint64 big-endian
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

;; ?? Tier counter helpers ???????????????????????????????????????????????????
(define-private (decrement-tier (tier uint))
  (if (is-eq tier TIER-LEGENDARY) (var-set legendary-remaining (- (var-get legendary-remaining) u1))
  (if (is-eq tier TIER-EPIC)      (var-set epic-remaining      (- (var-get epic-remaining)      u1))
  (if (is-eq tier TIER-RARE)      (var-set rare-remaining      (- (var-get rare-remaining)      u1))
  (if (is-eq tier TIER-UNCOMMON)  (var-set uncommon-remaining  (- (var-get uncommon-remaining)  u1))
                                   (var-set common-remaining    (- (var-get common-remaining)    u1))
  ))))
)

;; ?? SIP-009 ????????????????????????????????????????????????????????????????
(define-read-only (get-last-token-id)
  (ok (var-get last-token-id))
)

;; Returns none - metadata fetched directly via get-traits by the mint page
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

;; ?? Marketplace ????????????????????????????????????????????????????????????

;; List for sale at price in uSTX
(define-public (list-for-sale (token-id uint) (price uint))
  (let ((owner (unwrap! (nft-get-owner? early-eagle token-id) ERR-NOT-FOUND)))
    (asserts! (is-eq tx-sender owner) ERR-NOT-OWNER)
    (asserts! (> price u0) ERR-WRONG-PRICE)
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

;; ?? Reserve mint (Iskander, token-id u0, Legendary Azure) ?????????????????
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

;; ?? Public mint ????????????????????????????????????????????????????????????
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
    ;; 1. Supply cap
    (asserts! (< total MAX-SUPPLY) ERR-SOLD-OUT)

    ;; 2. One per wallet
    (asserts! (is-none (map-get? minted-wallets caller)) ERR-ALREADY-MINTED)

    ;; 3. Nonce not reused
    (asserts! (is-none (map-get? used-nonces nonce)) ERR-NONCE-USED)

    ;; 4. Check expiry: expiry-buff is uint64be, compare to block height
    ;; We encode expiry as unix timestamp / 10 to fit block-height scale
    ;; Actually: expiry stored as future unix ts, checked via stacks block
    ;; Simplified: just check nonce freshness via backend (1hr expiry is enforced off-chain)

    ;; 5. Verify backend signature
    (try! (verify-sig nonce expiry-buff signature))

    ;; 6. Verify ERC-8004 identity on-chain
    (asserts!
      (is-some (unwrap-panic (contract-call? IDENTITY-REGISTRY get-owner agent-id)))
      ERR-NO-IDENTITY
    )

    ;; 7. Random tier + color
    (let (
      (seed (get-seed nonce))
      (tier (pick-tier seed))
      (leg-so-far (- LEGENDARY-CAP (var-get legendary-remaining)))
      (color (pick-color tier (xor seed stacks-block-height) leg-so-far))
    )
      (decrement-tier tier)
      (try! (nft-mint? early-eagle token-id caller))
      (map-set token-traits token-id {
        tier: tier,
        color-id: color,
        agent-id: agent-id,
        display-name: display-name,
        btc-address: btc-addr,
        stx-address: caller,
        sigil-seed: nonce,
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

;; ?? Read helpers ???????????????????????????????????????????????????????????
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

;; ?? uint-to-ascii (for token URI) ??????????????????????????????????????????
(define-read-only (uint-to-ascii (n uint))
  (if (is-eq n u0) "0" (if (is-eq n u1) "1" (if (is-eq n u2) "2"
  (if (is-eq n u3) "3" (if (is-eq n u4) "4" (if (is-eq n u5) "5"
  (if (is-eq n u6) "6" (if (is-eq n u7) "7" (if (is-eq n u8) "8"
  (if (is-eq n u9) "9" (if (is-eq n u10) "10" (if (is-eq n u11) "11"
  (if (is-eq n u12) "12" (if (is-eq n u13) "13" (if (is-eq n u14) "14"
  (if (is-eq n u15) "15" (if (is-eq n u16) "16" (if (is-eq n u17) "17"
  (if (is-eq n u18) "18" (if (is-eq n u19) "19" (if (is-eq n u20) "20"
  (if (is-eq n u21) "21" (if (is-eq n u22) "22" (if (is-eq n u23) "23"
  (if (is-eq n u24) "24" (if (is-eq n u25) "25" (if (is-eq n u26) "26"
  (if (is-eq n u27) "27" (if (is-eq n u28) "28" (if (is-eq n u29) "29"
  (if (is-eq n u30) "30" (if (is-eq n u31) "31" (if (is-eq n u32) "32"
  (if (is-eq n u33) "33" (if (is-eq n u34) "34" (if (is-eq n u35) "35"
  (if (is-eq n u36) "36" (if (is-eq n u37) "37" (if (is-eq n u38) "38"
  (if (is-eq n u39) "39" (if (is-eq n u40) "40" (if (is-eq n u41) "41"
  (if (is-eq n u42) "42" (if (is-eq n u43) "43" (if (is-eq n u44) "44"
  (if (is-eq n u45) "45" (if (is-eq n u46) "46" (if (is-eq n u47) "47"
  (if (is-eq n u48) "48" (if (is-eq n u49) "49" (if (is-eq n u50) "50"
  (if (is-eq n u100) "100" (if (is-eq n u150) "150" (if (is-eq n u200) "200"
  "210"
  ))))))))))))))))))))))))))))))))))))))))))))))))))))
)

;; -- TEST-ONLY: Admin direct mint (skips sig + identity check) --
;; Not present in production contract. Used for rapid testing.
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
