---
"@triplex-build/triplex": minor
"@triplex-build/triplex-sql": minor
"@triplex-build/triplex-sqlite": minor
"@triplex-build/triplex-postgres": minor
"@triplex-build/triplex-testkit": minor
"@triplex-build/triplex-http": minor
"@triplex-build/triplex-cli": minor
---

Add opt-in sensitive attribute values. `Attribute.sensitive` marks an attribute in its
content-addressed config node. The new `@triplex-build/triplex/sensitive` entrypoint provides
`Sensitive.layer`, a `Triples` decorator that seals sensitive values through a pluggable
`ValueCodec` before storage. It ships an AES-256-GCM reference codec over WebCrypto with a keyed
blind index, a non-confidential identity codec for development, and test-only `KeyProvider` keys
with rotation and destruction. Reads, the journal and snapshots return sealed values, and
`Sensitive.open` is the only path to plaintext. Datalog, uniqueness and derivations support
presence and blind-token equality; projections, ordering, predicates, aggregates, rules and joins
with plaintext fail during planning with `SensitiveQueryError`.

`TripleValue`, `ValueType` and `Triple["value"]` gain the `sealed` variant, and Datalog typed
constants gain `{ type: "blind" }`. Code that switches exhaustively over `value.type` must handle
`sealed`. SQL migration v3 adds `value_sealed`, `value_blind` and `idx_attr_blind`. PostgreSQL
widens its value-type check in place; SQLite rebuilds the `triples` table, which takes time
proportional to its size. `Migration` gains optional per-dialect statements, and `runMigrations`
applies each migration atomically. HTTP renders sensitive fields as a `$sealed` marker and refuses
sensitive writes without the decorator. The CLI prints sealed values without ciphertext or blind
tokens. The testkit exports sealed-value conformance cases and plaintext-scan helpers.
