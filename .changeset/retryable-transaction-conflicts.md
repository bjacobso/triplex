---
"@triplex-build/triplex": minor
"@triplex-build/triplex-postgres": minor
"@triplex-build/triplex-testkit": patch
---

Surface structured PostgreSQL serialization and deadlock failures as
`TransactionConflictError` rather than wrapping them in `WriteError`. Conflicts
now expose `isRetryable: true`, an optional `serialization`/`deadlock` reason,
and the original cause. Existing precondition conflicts retain their identity.

Add `PgTriples.withTransaction` for typed conflicts spanning host SQL, nested
Triplex calls, and the outer commit. Other host SQL/domain errors remain unchanged.
There are no automatic retries; reload state and retry the entire host transaction.
The allocator and commit-order guarantees are unchanged; no migration is needed.

This pre-1.0 change widens convenience write methods and adapter transaction error
channels to include `TransactionConflictError`; the sensitive decorator preserves
it too. `OverlayError` follows the widened assertion contract. Callers with explicit
error annotations may need to add this type, and Postgres callers catching only
`WriteError` for native conflicts should handle `TransactionConflictError` instead.
