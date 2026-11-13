---
"@triplex-build/triplex": minor
---

Add `SqlKeyStore`, an opt-in reference `KeyProvider` and `KeyCustody` for SQLite and PostgreSQL that keeps
data keys and blind keys in the database's own SQL storage, wrapped under a `RootKey` the host supplies.
The root key is never written to the database. SQL migration v10 adds `triplex_data_keys`,
`triplex_blind_keys` and `triplex_key_erasures`. `RootKey.fromBytes` wraps with AES-256-GCM and accepts
previous root keys for rotation. `SqliteTriples.layerWithSqlClient` and `layerMemoryWithSqlClient` also output
the SQLite client so the key store can share the database. The testkit adds `makeKeyStoreSuite` and
`keyStoreCases` for any key provider with custody. The test provider's blind key ID is now `test-blind.v1`.
