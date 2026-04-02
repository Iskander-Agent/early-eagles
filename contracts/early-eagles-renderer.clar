;; Early Eagles Renderer ?
;; Returns data:text/html token URI with injected on-chain traits
;; Called by early-eagles.clar get-token-uri

;; ?? Color name lookup ????????????????????????????????????????????????????????
(define-read-only (color-name (id uint))
  (if (is-eq id u0)  "Azure"
  (if (is-eq id u1)  "Amethyst"
  (if (is-eq id u2)  "Fuchsia"
  (if (is-eq id u3)  "Crimson"
  (if (is-eq id u4)  "Amber"
  (if (is-eq id u5)  "Jade"
  (if (is-eq id u6)  "Forest"
  (if (is-eq id u7)  "Teal"
  (if (is-eq id u8)  "Prism"
  (if (is-eq id u9)  "Cobalt"
  (if (is-eq id u10) "Chartreuse"
  (if (is-eq id u11) "Violet"
  (if (is-eq id u12) "Gold"
  (if (is-eq id u13) "Pearl"
  (if (is-eq id u14) "Sepia"
  (if (is-eq id u15) "Shadow"
  (if (is-eq id u16) "Negative"
  (if (is-eq id u17) "Thermal"
  (if (is-eq id u18) "X-Ray"
  (if (is-eq id u19) "Aurora"
  "Psychedelic"))))))))))))))))))))
)

(define-read-only (tier-name (id uint))
  (if (is-eq id u0) "Legendary"
  (if (is-eq id u1) "Epic"
  (if (is-eq id u2) "Rare"
  (if (is-eq id u3) "Uncommon"
  "Common"))))
)

(define-read-only (tier-symbol (id uint))
  (if (is-eq id u0) "Legendary"
  (if (is-eq id u1) "Epic"
  (if (is-eq id u2) "Rare"
  (if (is-eq id u3) "Uncommon"
  "Common"))))
)

;; ?? Main: get-token-uri ??????????????????????????????????????????????????????
;; NOTE: Full on-chain HTML rendering requires the contract to store the base64 eagle.
;; For testnet, we return a JSON metadata URI instead, and keep the full HTML render
;; for mainnet once the renderer contract is deployed with embedded art.
;;
;; The HTML template is injected via the renderer contract's stored art buffer.
;; For now, we return structured metadata that the mint-page can decode client-side.

(define-read-only (get-token-uri (token-id uint))
  (match (contract-call? .early-eagles get-traits token-id)
    traits
      (some (concat
        "data:application/json;charset=utf-8,{\"name\":\"Early Eagle #"
        (concat
          (uint-to-ascii token-id)
          (concat
            "\",\"description\":\"Genesis AIBTC agent NFT\",\"tier\":\""
            (concat
              (tier-name (get tier traits))
              (concat
                "\",\"color\":\""
                (concat
                  (color-name (get color-id traits))
                  (concat
                    "\",\"agent_id\":"
                    (concat
                      (uint-to-ascii (get agent-id traits))
                      "}"
                    )
                  )
                )
              )
            )
          )
        )
      ))
    none
  )
)

;; ?? uint to ASCII helper ?????????????????????????????????????????????????????
(define-read-only (uint-to-ascii (n uint))
  (if (is-eq n u0) "0"
  (if (is-eq n u1) "1"
  (if (is-eq n u2) "2"
  (if (is-eq n u3) "3"
  (if (is-eq n u4) "4"
  (if (is-eq n u5) "5"
  (if (is-eq n u6) "6"
  (if (is-eq n u7) "7"
  (if (is-eq n u8) "8"
  (if (is-eq n u9) "9"
  ;; for larger numbers we'll use a fold-based approach at deploy time
  "N"
  ))))))))))
)
