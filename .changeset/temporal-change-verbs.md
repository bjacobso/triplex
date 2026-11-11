---
"@triplex-build/triplex": minor
---

Add pure `Change.end`, `replace`, `correct`, and `combine` builders with TripleLive guards,
plus typed EntityType helpers that encode one aliased value. Temporal splits preserve the
original past and replacement end, and reject invalid split instants with ChangeRangeError.

Breaking change: EntityType aliases `end`, `replace`, and `correct` are now reserved for
the new helpers. Rename attributes using those TypeScript aliases; their global keys can stay
the same.

Sensitive temporal changes reuse existing ciphertext only when a same-transaction explicit
retraction identifies a stored fact with the same entity, attribute, envelope and blind token.
All other sealed inputs remain rejected; plaintext replacements seal through the usual write path.
