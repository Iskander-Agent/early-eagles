;; commission-stx.clar
;; Early Eagles royalty commission -- paid in STX.
;; Takes 5% of sale price and sends to the royalty wallet.
;; Seller passes this contract when listing in STX.

(impl-trait .commission-trait.commission)

;; 5% royalty to Iskander (Early Eagles creator wallet)
(define-constant ROYALTY-WALLET 'SP3JR7JXFT7ZM9JKSQPBQG1HPT0D365MA5TN0P12E)
(define-constant ROYALTY-BPS u500) ;; 500 basis points = 5%

(define-constant ERR-TRANSFER-FAILED (err u500))

;; Called by the NFT contract on every STX sale.
;; `id`    -- token ID (unused here, available for per-token overrides)
;; `price` -- full sale price in uSTX
;; Transfers 5% of price from contract-caller (the NFT contract) to royalty wallet.
(define-public (pay (id uint) (price uint))
  (let ((royalty (/ (* price ROYALTY-BPS) u10000)))
    (stx-transfer? royalty tx-sender ROYALTY-WALLET)))
