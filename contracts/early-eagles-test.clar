;; Early Eagles Test v5 - ultra minimal mint
(define-non-fungible-token early-eagle uint)
(define-constant CONTRACT-OWNER tx-sender)
(define-constant ERR-NOT-AUTHORIZED (err u401))
(define-data-var total-minted uint u0)

(define-map token-traits uint {
  tier: uint,
  color-id: uint,
  agent-id: uint,
  display-name: (string-utf8 64),
  btc-address: (string-ascii 62),
  stx-address: principal,
  minted-at: uint
})

(define-read-only (get-last-token-id) (ok (var-get total-minted)))
(define-read-only (get-token-uri (token-id uint)) (ok none))
(define-read-only (get-owner (token-id uint)) (ok (nft-get-owner? early-eagle token-id)))
(define-public (transfer (token-id uint) (sender principal) (recipient principal))
  (begin (asserts! (is-eq tx-sender sender) ERR-NOT-AUTHORIZED) (nft-transfer? early-eagle token-id sender recipient))
)
(define-read-only (get-traits (token-id uint)) (map-get? token-traits token-id))
(define-read-only (get-mint-stats) { total-minted: (var-get total-minted) })

(define-public (test-mint
    (recipient principal)
    (display-name (string-utf8 64))
    (btc-addr (string-ascii 62))
    (agent-id uint)
    (tier uint)
    (color-id uint))
  (let ((token-id (var-get total-minted)))
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-AUTHORIZED)
    (try! (nft-mint? early-eagle token-id recipient))
    (map-set token-traits token-id {
      tier: tier, color-id: color-id, agent-id: agent-id,
      display-name: display-name, btc-address: btc-addr,
      stx-address: recipient, minted-at: stacks-block-height
    })
    (var-set total-minted (+ token-id u1))
    (ok { token-id: token-id, tier: tier, color-id: color-id })
  )
)
