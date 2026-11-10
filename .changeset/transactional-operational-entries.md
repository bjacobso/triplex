---
"@triplex-build/triplex": minor
"@triplex-build/triplex-sql": minor
"@triplex-build/triplex-sqlite": patch
"@triplex-build/triplex-postgres": patch
"@triplex-build/triplex-testkit": minor
---

Add indexed inbox/outbox entries that compose with facts in `transact`, deduplicate
canonical payloads by scoped idempotency key, page pending work globally or per
entity, and retain acknowledged history. A different payload for an existing key
fails atomically with non-retryable `OperationalEntryConflictError`.

Breaking pre-1.0 extension: `TransactOp` has `append-entry` and `acknowledge-entry`
variants, `TriplesService` has two new read methods, and `StorageAdapterService`
requires four entry persistence methods. Update custom implementations, exhaustive
switches, and explicit transaction error unions. Host-owned SQL must apply migration
v5 before layer construction; Cloudflare applies v6. KV needs no data migration.
Payloads are canonical JSON supplied by the host and are outside attribute-based
sensitive-value policies; hosts seal sensitive contents before appending.
