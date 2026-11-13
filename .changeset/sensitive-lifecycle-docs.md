---
"@triplex-build/triplex": patch
---

Document sensitive values as complete: key classes, the key store, erasure and rotation are built, and the
remaining deferred items are listed. Record the decision that hosts supply keys through `KeyProvider` and
`KeyCustody` rather than importing host-sealed values; the host-sealed values RFC is marked not adopted. Add the
`sensitive-lifecycle` example.
