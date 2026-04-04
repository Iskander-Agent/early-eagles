;; commission-trait.clar
;; Standard commission trait used by Early Eagles marketplace.
;; Any commission contract must implement this -- called on every sale.

(define-trait commission
  ((pay (uint uint) (response bool uint))))
