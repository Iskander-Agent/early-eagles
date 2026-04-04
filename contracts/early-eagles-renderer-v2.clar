;; early-eagles-renderer.clar
;; Stores the full Early Eagles card HTML (split into 3 segments + eagle PNG b64) on-chain.
;; Assembled card = seg1 + eagle_b64 + seg2 + agent_json + seg3
;; All data is pure ASCII. Set once after deploy, locked forever.
;;
;; Architecture:
;;   seg1  - HTML + CSS + opening JS up to eagle injection point        (~3.4KB)
;;   eagle - base64-encoded 420x420 PNG                                 (~50KB)
;;   seg2  - bridge string between eagle and agent JSON                 (8 chars)
;;   seg3  - all JS engines + init code + closing tags                  (~14.8KB)
;;
;; get-card-html assembles: concat(concat(concat(concat(seg1,eagle),seg2),agent_json),seg3)
;; All concats are strictly binary - Clarity type-checks cleanly.

(define-constant CONTRACT-OWNER tx-sender)
(define-constant ERR-NOT-AUTHORIZED (err u401))
(define-constant ERR-ALREADY-SET    (err u402))
(define-constant ERR-NOT-SET        (err u403))

;; -- Storage (set once, locked) ------------------------------------------------

(define-data-var seg1  (string-ascii 4096)  "")
(define-data-var eagle (string-ascii 65536) "")
(define-data-var seg2  (string-ascii 16)    "")
(define-data-var seg3  (string-ascii 16384) "")
(define-data-var data-locked bool false)

;; -- Set functions (owner only, one-time each) ---------------------------------

(define-public (set-seg1 (data (string-ascii 4096)))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-AUTHORIZED)
    (asserts! (not (var-get data-locked)) ERR-ALREADY-SET)
    (var-set seg1 data)
    (ok true)))

(define-public (set-eagle (data (string-ascii 65536)))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-AUTHORIZED)
    (asserts! (not (var-get data-locked)) ERR-ALREADY-SET)
    (var-set eagle data)
    (ok true)))

(define-public (set-seg2 (data (string-ascii 16)))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-AUTHORIZED)
    (asserts! (not (var-get data-locked)) ERR-ALREADY-SET)
    (var-set seg2 data)
    (ok true)))

(define-public (set-seg3 (data (string-ascii 16384)))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-AUTHORIZED)
    (asserts! (not (var-get data-locked)) ERR-ALREADY-SET)
    (var-set seg3 data)
    (ok true)))

;; Lock all data permanently (call after all 4 segments are set)
(define-public (lock-data)
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-AUTHORIZED)
    (asserts! (not (var-get data-locked)) ERR-ALREADY-SET)
    (var-set data-locked true)
    (ok true)))

;; -- Read helpers --------------------------------------------------------------

(define-read-only (is-ready)
  (and
    (> (len (var-get seg1))  u0)
    (> (len (var-get eagle)) u0)
    (> (len (var-get seg2))  u0)
    (> (len (var-get seg3))  u0)))

(define-read-only (is-locked) (var-get data-locked))

;; -- Card assembly -------------------------------------------------------------
;;
;; Returns full standalone HTML card for one NFT token.
;; agent-json must be a valid JSON object string, e.g.:
;;   {"rank":124,"tier":0,"cid":10,"name":"Iskander","btc":"bc1q..."}
;;
;; Caller is responsible for building agent-json from on-chain traits.
;; The NFT contract's get-token-uri calls this and wraps in data:text/html.

(define-read-only (get-card-html (agent-json (string-ascii 256)))
  (if (not (is-ready))
    (err ERR-NOT-SET)
    (ok (concat
          (concat
            (concat
              (concat (var-get seg1) (var-get eagle))
              (var-get seg2))
            agent-json)
          (var-get seg3)))))

;; -- Individual segment getters (for off-chain assembly) ----------------------
;; The full get-card-html exceeds Stacks' read-only simulation cost limit (~100K read_length)
;; because all 4 segments total ~68KB. Consumers read each segment separately and assemble.
;; The data is still 100% on-chain -- just read in parts.

(define-read-only (get-seg1)  (var-get seg1))
(define-read-only (get-eagle) (var-get eagle))
(define-read-only (get-seg2)  (var-get seg2))
(define-read-only (get-seg3)  (var-get seg3))
