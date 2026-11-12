---
"@triplex-build/triplex": minor
---

Add `entityIdPrefix` to `transactions({ after, limit })` and tenant-protocol
Transactions requests. Filtered pages return complete authoritative records for
commands touching a matching entity, deduplicate multiple matching entities, and
preserve global position ordering and exclusive resume cursors. Prefix matching is
literal and case-sensitive, including Unicode; an explicit empty prefix selects
transactions with at least one fact change.

Breaking pre-1.0 adapter extension: custom `StorageAdapterService` implementations
must add indexed `transactionIdsForEntityPrefix` discovery. SQL migration v7 adds
PostgreSQL's binary-collation covering journal index and analyzes triples; SQLite
records v7 without extra DDL. Cloudflare uses its existing reference index and
needs no additional migration beyond v6. KV reuses its existing changed-entity
index, with no feed backfill; its candidate work scales with matching prefix
history, while unrelated transactions are not read. Upgrade the host package too
when using the new filter through the tenant protocol.
