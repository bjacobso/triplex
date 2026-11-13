---
"@triplex-build/triplex": minor
---

Add key rotation for sensitive values. `SqlKeyStore.rewrapRoot` rewraps stored keys under a new root key so the
old one can be destroyed. `Sensitive.rewrap` reseals stored values, current and retracted, and their journal copies
under each scope's current data key after `KeyCustody.rotate`; `KeyCustody.retire` then destroys the replaced
versions. `Sensitive.rotateBlindKey` stages a new blind key, recomputes every token under it, activates it and
recomputes tokens written meanwhile; equality may miss values between the rewrite and the activation, so run it
when writes are quiet. `KeyCustody` gains `retire`, `stageBlindKey` and `activateBlindKey`; `ValueCodec` gains the
optional `reseal` and `blindWith`; `Triples` gains the optional `sealedFacts` and `rewriteValues` maintenance
operations on in-memory KV, SQLite and PostgreSQL. SQL migration v12 adds a `staged` flag to blind keys. The
testkit adds `makeRotationSuite` and `rotationCases`.
