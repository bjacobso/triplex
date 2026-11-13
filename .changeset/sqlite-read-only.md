---
"@triplex-build/triplex": minor
---

Add `SqliteTriples.layerReadOnly({ filename })`: `Triples` over an existing SQLite file opened read-only, with no
migration and every write refused with `WriteError`. Acquisition fails with `SchemaVersionError` when the file is not
at this release's schema version (`actualVersion` is zero without a Triplex schema). `SchemaVersionError` moves to
`@triplex-build/triplex/sql` and is still exported from `/postgres`.
