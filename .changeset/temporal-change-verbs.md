---
"@triplex-build/triplex": minor
---

Add pure `Change.end`, `replace`, `correct`, and `combine` builders with TripleLive guards,
plus typed EntityType helpers that encode one aliased value. Temporal splits preserve the
original past and replacement end, and reject invalid split instants with ChangeRangeError.

Breaking change: EntityType aliases `end`, `replace`, and `correct` are now reserved for
the new helpers. Rename attributes using those TypeScript aliases; their global keys can stay
the same. Sealed-value end/replace operations require sensitive decorator support for reasserting
existing ciphertext; plaintext corrections already seal through the existing write path.
