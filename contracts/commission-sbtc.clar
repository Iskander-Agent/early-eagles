;; commission-sbtc.clar
;; Early Eagles royalty commission — paid in sBTC.
;; Takes 5% of sale price and sends to the royalty wallet.
;; Seller passes this contract when listing in sBTC.

(impl-trait .commission-trait.commission)

;; Mainnet sBTC token contract
(define-constant SBTC-CONTRACT 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)

;; 5% royalty to Iskander (Early Eagles creator wallet)
(define-constant ROYALTY-WALLET 'SP3JR7JXFT7ZM9JKSQPBQG1HPT0D365MA5TN0P12E)
(define-constant ROYALTY-BPS u500) ;; 500 basis points = 5%

(define-constant ERR-TRANSFER-FAILED (err u500))

;; Called by the NFT contract on every sBTC sale.
;; Transfers 5% of price from buyer (tx-sender at call time) to royalty wallet.
;; Note: the NFT contract calls contract-call? on this after transferring
;; the full price from buyer → seller. The royalty comes from tx-sender
;; which is the buyer in the buy-in-sbtc flow.
(define-public (pay (id uint) (price uint))
  (let ((royalty (/ (* price ROYALTY-BPS) u10000)))
    (contract-call? SBTC-CONTRACT transfer royalty tx-sender ROYALTY-WALLET none)))
