---
"@triplex-build/triplex": minor
"@triplex-build/triplex-testkit": minor
---

Add `journal: "summary"` to `TransactionMeta`. Such a transaction records one `:_tx/summary`
(counts, changed attributes, and a content digest) instead of one `:_tx/change` per fact; its
record and result carry a `summary` and its record has no `changes`.
