;; Early Eagles ?
;; SIP-009 NFT Contract ? one eagle for each of the first 210 Genesis AIBTC agents
;; 
;; Mint gate:
;;   1. Caller presents a backend-signed authorization (sig over stxAddress + nonce + expiry)
;;   2. Contract verifies signature against hardcoded signer public key
;;   3. Caller must own a token in the AIBTC identity registry (ERC-8004)
;;   4. One mint per wallet
;;   5. Hard cap: 210 tokens (token-id 0 reserved for Iskander, pre-minted at deploy)
;;
;; Rarity: weighted random draw from remaining tier slots
;;   Legendary: 10  |  Epic: 30  |  Rare: 40  |  Uncommon: 70  |  Common: 60
;;
;; On-chain renderer: early-eagles-renderer.clar returns data:text/html

;; ?? SIP-009 trait ???????????????????????????????????????????????????????????
(impl-trait 'SP2PABAF9FTAJYNFN104XMK2EH7PF4CQPH6HJ7HKP.nft-trait.nft-trait)

;; ?? Constants ???????????????????????????????????????????????????????????????
(define-constant CONTRACT-OWNER tx-sender)
(define-constant IDENTITY-REGISTRY 'SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2)

;; Signer public key (33 bytes compressed secp256k1) ? set at deploy, never changes
(define-constant SIGNER-PUBKEY 0x022bb7747cfa7c1f77e1a96993f9f2699ea927a8c8f20ea5799bdc26072573027e)

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

;; Error codes
(define-constant ERR-NOT-AUTHORIZED (err u401))
(define-constant ERR-ALREADY-MINTED (err u402))
(define-constant ERR-SOLD-OUT (err u403))
(define-constant ERR-INVALID-SIG (err u404))
(define-constant ERR-SIG-EXPIRED (err u405))
(define-constant ERR-NO-IDENTITY (err u406))
(define-constant ERR-NONCE-USED (err u407))
(define-constant ERR-NOT-FOUND (err u404))
(define-constant ERR-NOT-OWNER (err u403))

;; ?? NFT definition ??????????????????????????????????????????????????????????
(define-non-fungible-token early-eagle uint)

;; ?? Storage ?????????????????????????????????????????????????????????????????
(define-data-var last-token-id uint u0)
(define-data-var total-minted uint u0)

;; Tier remaining slots
(define-data-var legendary-remaining uint LEGENDARY-CAP)
(define-data-var epic-remaining uint EPIC-CAP)
(define-data-var rare-remaining uint RARE-CAP)
(define-data-var uncommon-remaining uint UNCOMMON-CAP)
(define-data-var common-remaining uint COMMON-CAP)

;; Token traits
(define-map token-traits uint {
  tier: uint,        ;; 0=Legendary 1=Epic 2=Rare 3=Uncommon 4=Common
  color-id: uint,    ;; 0-20 per the 21 color traits
  agent-id: uint,    ;; ERC-8004 agent ID
  display-name: (string-utf8 64),
  btc-address: (string-ascii 62),
  stx-address: principal,
  sigil-seed: (buff 16),  ;; used by renderer for DNA sigil generation
  minted-at: uint    ;; block height
})

;; One mint per wallet
(define-map minted-wallets principal bool)

;; Used nonces (prevent sig replay)
(define-map used-nonces (buff 16) bool)

;; ?? Color trait tables ???????????????????????????????????????????????????????
;; Colors available per tier (indices into the 21-color array)
;; 0=Azure 1=Amethyst 2=Fuchsia 3=Crimson 4=Amber 5=Jade 6=Forest 7=Teal
;; 8=Prism 9=Cobalt 10=Chartreuse 11=Violet 12=Gold 13=Pearl 14=Sepia
;; 15=Shadow 16=Negative 17=Thermal 18=X-Ray 19=Aurora 20=Psychedelic

;; Legendary colors: all 10 are 1-of-1, assigned in order of minting
;; [Gold, X-Ray, Aurora, Psychedelic, Thermal, Negative, Sepia, Shadow, Pearl, Azure]
;; (Azure saved for Iskander's reserved mint at token-id 0)
(define-read-only (legendary-color-for-index (idx uint))
  (if (is-eq idx u0) u12        ;; Gold
  (if (is-eq idx u1) u18        ;; X-Ray
  (if (is-eq idx u2) u19        ;; Aurora
  (if (is-eq idx u3) u20        ;; Psychedelic
  (if (is-eq idx u4) u17        ;; Thermal
  (if (is-eq idx u5) u16        ;; Negative
  (if (is-eq idx u6) u14        ;; Sepia
  (if (is-eq idx u7) u15        ;; Shadow
  (if (is-eq idx u8) u13        ;; Pearl
  u0)))))))))                   ;; Azure (idx 9, 10th legendary)
)

;; Epic colors (10 options): Azure, Amethyst, Crimson, Amber, Pearl, Forest, Teal, Prism, Chartreuse, Shadow
(define-read-only (epic-color-count) u10)
(define-read-only (epic-color-for-index (idx uint))
  (if (is-eq idx u0) u0    ;; Azure
  (if (is-eq idx u1) u1    ;; Amethyst
  (if (is-eq idx u2) u3    ;; Crimson
  (if (is-eq idx u3) u4    ;; Amber
  (if (is-eq idx u4) u13   ;; Pearl
  (if (is-eq idx u5) u6    ;; Forest
  (if (is-eq idx u6) u7    ;; Teal
  (if (is-eq idx u7) u8    ;; Prism
  (if (is-eq idx u8) u10   ;; Chartreuse
  u15)))))))))              ;; Shadow (idx 9)
)

;; Rare colors: same set as Epic
(define-read-only (rare-color-count) u10)
(define-read-only (rare-color-for-index (idx uint)) (epic-color-for-index idx))

;; Uncommon colors (12 options): Azure, Amethyst, Fuchsia, Crimson, Amber, Jade, Forest, Teal, Prism, Cobalt, Chartreuse, Violet
(define-read-only (uncommon-color-count) u12)
(define-read-only (uncommon-color-for-index (idx uint))
  (if (is-eq idx u0)  u0   ;; Azure
  (if (is-eq idx u1)  u1   ;; Amethyst
  (if (is-eq idx u2)  u2   ;; Fuchsia
  (if (is-eq idx u3)  u3   ;; Crimson
  (if (is-eq idx u4)  u4   ;; Amber
  (if (is-eq idx u5)  u5   ;; Jade
  (if (is-eq idx u6)  u6   ;; Forest
  (if (is-eq idx u7)  u7   ;; Teal
  (if (is-eq idx u8)  u8   ;; Prism
  (if (is-eq idx u9)  u9   ;; Cobalt
  (if (is-eq idx u10) u10  ;; Chartreuse
  u11)))))))))))            ;; Violet (idx 11)
)

;; Common colors: same set as Uncommon
(define-read-only (common-color-count) u12)
(define-read-only (common-color-for-index (idx uint)) (uncommon-color-for-index idx))

;; ?? Random seed ?????????????????????????????????????????????????????????????
(define-private (get-random-seed (nonce (buff 16)))
  (buff-to-uint-be
    (sha256
      (concat
        (unwrap-panic (get-block-info? id-header-hash (- stacks-block-height u1)))
        (hash160 tx-sender)
        nonce
      )
    )
  )
)

;; ?? Tier selection (weighted random from remaining slots) ???????????????????
(define-private (pick-tier (seed uint))
  (let (
    (leg (var-get legendary-remaining))
    (epc (var-get epic-remaining))
    (rar (var-get rare-remaining))
    (unc (var-get uncommon-remaining))
    (com (var-get common-remaining))
    (total (+ (+ (+ (+ leg epc) rar) unc) com))
    (roll (mod seed total))
  )
    (if (< roll leg) TIER-LEGENDARY
    (if (< roll (+ leg epc)) TIER-EPIC
    (if (< roll (+ (+ leg epc) rar)) TIER-RARE
    (if (< roll (+ (+ (+ leg epc) rar) unc)) TIER-UNCOMMON
    TIER-COMMON))))
  )
)

;; ?? Color selection (random within tier) ????????????????????????????????????
(define-private (pick-color (tier uint) (seed uint) (legendary-minted uint))
  (if (is-eq tier TIER-LEGENDARY)
    ;; Legendary: each color is 1-of-1, assigned in minting order
    (legendary-color-for-index legendary-minted)
  (if (is-eq tier TIER-EPIC)
    (epic-color-for-index (mod seed (epic-color-count)))
  (if (is-eq tier TIER-RARE)
    (rare-color-for-index (mod seed (rare-color-count)))
  (if (is-eq tier TIER-UNCOMMON)
    (uncommon-color-for-index (mod seed (uncommon-color-count)))
    ;; Common
    (common-color-for-index (mod seed (common-color-count)))
  ))))
)

;; ?? Signature verification ???????????????????????????????????????????????????
;; Backend signs: keccak256(stxAddress_utf8_bytes || nonce_16bytes || expiry_uint64be)
(define-private (build-msg-hash
    (stx-addr (string-ascii 62))
    (nonce (buff 16))
    (expiry uint))
  (keccak256
    (concat
      (string-to-bytes stx-addr)
      nonce
      (uint-to-buff-8 expiry)
    )
  )
)

(define-private (string-to-bytes (s (string-ascii 62)))
  ;; Clarity doesn't have a direct string?buff cast of arbitrary length,
  ;; so we encode the address as its principal bytes via hash trick.
  ;; The backend must use the same encoding: UTF-8 bytes of the address string.
  ;; We use (unwrap-panic (to-consensus-buff? (principal-of? ...))) as a proxy.
  ;; IMPORTANT: backend must hash the same way ? see worker/src/index.js
  (sha256 (unwrap-panic (to-consensus-buff? tx-sender)))
)

(define-private (uint-to-buff-8 (n uint))
  (unwrap-panic (to-consensus-buff? n))
)

;; ?? SIP-009 required functions ???????????????????????????????????????????????
(define-read-only (get-last-token-id)
  (ok (var-get last-token-id))
)

(define-read-only (get-token-uri (token-id uint))
  (ok (some (contract-call? .early-eagles-renderer get-token-uri token-id)))
)

(define-read-only (get-owner (token-id uint))
  (ok (nft-get-owner? early-eagle token-id))
)

(define-public (transfer (token-id uint) (sender principal) (recipient principal))
  (begin
    (asserts! (is-eq tx-sender sender) ERR-NOT-OWNER)
    (nft-transfer? early-eagle token-id sender recipient)
  )
)

;; ?? Admin: reserve mint for Iskander (token-id 0, Legendary Azure) ??????????
(define-public (reserve-iskander
    (display-name (string-utf8 64))
    (btc-addr (string-ascii 62))
    (agent-id uint))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-AUTHORIZED)
    (asserts! (is-eq (var-get total-minted) u0) ERR-ALREADY-MINTED)
    ;; Mint token-id 0 to contract owner (Iskander's STX wallet)
    (try! (nft-mint? early-eagle u0 tx-sender))
    (map-set token-traits u0 {
      tier: TIER-LEGENDARY,
      color-id: u0,          ;; Azure
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
    (ok u0)
  )
)

;; ?? Public mint ??????????????????????????????????????????????????????????????
(define-public (mint
    (nonce (buff 16))
    (expiry uint)
    (signature (buff 65))
    (agent-id uint)
    (display-name (string-utf8 64))
    (btc-addr (string-ascii 62)))
  (let (
    (caller tx-sender)
    (total (var-get total-minted))
    (token-id (+ total u1))   ;; token-id 0 is Iskander's
  )

    ;; 1. Supply cap
    (asserts! (< total MAX-SUPPLY) ERR-SOLD-OUT)

    ;; 2. One mint per wallet
    (asserts! (is-none (map-get? minted-wallets caller)) ERR-ALREADY-MINTED)

    ;; 3. Nonce not reused
    (asserts! (is-none (map-get? used-nonces nonce)) ERR-NONCE-USED)

    ;; 4. Sig not expired
    (asserts! (< stacks-block-height expiry) ERR-SIG-EXPIRED)

    ;; 5. Verify backend signature
    ;; sig = secp256k1(privkey, keccak256(principal_consensus_bytes || nonce || expiry_buff))
    (let (
      (msg-hash (keccak256 (concat
        (concat
          (unwrap-panic (to-consensus-buff? caller))
          nonce
        )
        (unwrap-panic (to-consensus-buff? expiry))
      )))
      (recovered (unwrap! (secp256k1-recover? msg-hash signature) ERR-INVALID-SIG))
    )
      (asserts! (is-eq recovered SIGNER-PUBKEY) ERR-INVALID-SIG)
    )

    ;; 6. Verify caller owns an ERC-8004 identity
    (asserts!
      (is-some
        (unwrap-panic
          (contract-call? IDENTITY-REGISTRY get-owner agent-id)
        )
      )
      ERR-NO-IDENTITY
    )

    ;; 7. Random tier + color draw
    (let (
      (seed (get-random-seed nonce))
      (tier (pick-tier seed))
      (legendary-so-far (- LEGENDARY-CAP (var-get legendary-remaining)))
      (color (pick-color tier (xor seed stacks-block-height) legendary-so-far))
      (sigil-bytes (unwrap-panic (as-max-len? nonce u16)))
    )

      ;; 8. Decrement tier counter
      (if (is-eq tier TIER-LEGENDARY)
        (var-set legendary-remaining (- (var-get legendary-remaining) u1))
      (if (is-eq tier TIER-EPIC)
        (var-set epic-remaining (- (var-get epic-remaining) u1))
      (if (is-eq tier TIER-RARE)
        (var-set rare-remaining (- (var-get rare-remaining) u1))
      (if (is-eq tier TIER-UNCOMMON)
        (var-set uncommon-remaining (- (var-get uncommon-remaining) u1))
        (var-set common-remaining (- (var-get common-remaining) u1))
      ))))

      ;; 9. Mint
      (try! (nft-mint? early-eagle token-id caller))

      ;; 10. Store traits
      (map-set token-traits token-id {
        tier: tier,
        color-id: color,
        agent-id: agent-id,
        display-name: display-name,
        btc-address: btc-addr,
        stx-address: caller,
        sigil-seed: sigil-bytes,
        minted-at: stacks-block-height
      })

      ;; 11. Mark wallet + nonce used
      (map-set minted-wallets caller true)
      (map-set used-nonces nonce true)
      (var-set total-minted (+ total u1))
      (var-set last-token-id token-id)

      (ok token-id)
    )
  )
)

;; ?? Read-only helpers ????????????????????????????????????????????????????????
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
    common-remaining: (var-get common-remaining),
  }
)

(define-read-only (has-minted (wallet principal))
  (is-some (map-get? minted-wallets wallet))
)
