;; commission-sbtc-testnet.clar
;; TESTNET VERSION -- Phase 1 test deploy
;;
;; Changes from mainnet:
;;   - SBTC-CONTRACT: STV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RJ5XDY2.sbtc-token (testnet)
;;   - ROYALTY-WALLET: testnet ST address (converted from mainnet SP3JR7...)

(impl-trait .commission-trait.commission)

;; Testnet sBTC token contract (has faucet function)
(define-constant SBTC-CONTRACT 'STV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RJ5XDY2.sbtc-token)

;; 5% royalty -- testnet Iskander wallet (ST conversion of SP3JR7...TN0P12E)
(define-constant ROYALTY-WALLET 'ST3JR7JXFT7ZM9JKSQPBQG1HPT0D365MA5TX3DS8N)
(define-constant ROYALTY-BPS u500) ;; 500 basis points = 5%

;; Called by the NFT contract on every sBTC sale.
;; Transfers 5% of price from buyer to royalty wallet.
(define-public (pay (id uint) (price uint))
  (let ((royalty (/ (* price ROYALTY-BPS) u10000)))
    (contract-call? SBTC-CONTRACT transfer royalty tx-sender ROYALTY-WALLET none)))
