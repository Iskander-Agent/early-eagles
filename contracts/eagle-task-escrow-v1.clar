;; eagle-task-escrow-v1
;; STX escrow for the Early Eagles Task Exchange (A2A marketplace).
;;
;; Lifecycle:
;;   1. Creator posts task on API — receives task_id + task_hash (sha256 of task_id)
;;   2. Creator calls (lock-task <task-hash> <amount-ustx>) — locks STX in this contract
;;   3. Task is claimed and delivered via the API
;;   4a. Creator calls (release-task <task-hash> <claimer>) — pays claimer, closes escrow
;;   4b. Creator calls (cancel-task <task-hash>) — refunds creator (only while status=open)
;;
;; v1 constraints:
;;   - No dispute mechanism: creator decides release or cancel
;;   - No expiry / timeout (v2)
;;   - Cancel blocked after release (ERR-WRONG-STATUS)
;;   - Trust gating enforced off-chain by the API

(define-constant ERR-NOT-AUTHORIZED (err u401))
(define-constant ERR-ZERO-AMOUNT    (err u402))
(define-constant ERR-NOT-FOUND      (err u404))
(define-constant ERR-WRONG-STATUS   (err u400))
(define-constant ERR-ALREADY-EXISTS (err u409))

;; status: u0=open  u1=released  u2=cancelled
(define-map escrows
  { task-id: (buff 32) }
  { creator: principal, amount: uint, status: uint }
)

;; ── Lock STX when posting a task ────────────────────────────────────────────
(define-public (lock-task (task-id (buff 32)) (amount uint))
  (begin
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    (asserts! (is-none (map-get? escrows { task-id: task-id })) ERR-ALREADY-EXISTS)
    (try! (stx-transfer? amount tx-sender (as-contract tx-sender)))
    (map-set escrows { task-id: task-id }
      { creator: tx-sender, amount: amount, status: u0 })
    (ok { task-id: task-id, creator: tx-sender, amount: amount })
  )
)

;; ── Release STX to claimer (creator confirms delivery) ──────────────────────
(define-public (release-task (task-id (buff 32)) (claimer principal))
  (let ((e (unwrap! (map-get? escrows { task-id: task-id }) ERR-NOT-FOUND)))
    (asserts! (is-eq (get creator e) tx-sender) ERR-NOT-AUTHORIZED)
    (asserts! (is-eq (get status e) u0) ERR-WRONG-STATUS)
    (try! (as-contract (stx-transfer? (get amount e) tx-sender claimer)))
    (map-set escrows { task-id: task-id } (merge e { status: u1 }))
    (ok { task-id: task-id, claimer: claimer, amount: (get amount e) })
  )
)

;; ── Cancel and refund to creator (only while status=open) ───────────────────
(define-public (cancel-task (task-id (buff 32)))
  (let ((e (unwrap! (map-get? escrows { task-id: task-id }) ERR-NOT-FOUND)))
    (asserts! (is-eq (get creator e) tx-sender) ERR-NOT-AUTHORIZED)
    (asserts! (is-eq (get status e) u0) ERR-WRONG-STATUS)
    (try! (as-contract (stx-transfer? (get amount e) tx-sender (get creator e))))
    (map-set escrows { task-id: task-id } (merge e { status: u2 }))
    (ok { task-id: task-id, refunded-to: (get creator e), amount: (get amount e) })
  )
)

;; ── Read-only: query escrow state ───────────────────────────────────────────
(define-read-only (get-escrow (task-id (buff 32)))
  (map-get? escrows { task-id: task-id })
)
