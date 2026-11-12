---
"@triplex-build/triplex": minor
---

Add commit validators: host checks that run inside `Triples.transact` after operations and the
journal envelope are applied and before commit. Validators read `before` and `after` views at
exact commit positions (entity, match, and complete Datalog) and may return typed rejections that
fail the whole transaction with `CommitRejectedError`. `TransactionMeta.validate` installs them
per call; `CommitValidation.layer` decorates any `Layer<Triples>` so every application write path
runs them, and can durably record rejections as reserved facts after rollback.
`CommitValidation.recordRejection` and `readRejection` support hosts that roll back an enclosing
SQL transaction. **Breaking:** `Triples.transact` now includes `CommitRejectedError` in its error channel.
Exhaustive error handlers must handle it. Commit views also provide read-only, position-bound
inbox/outbox point and pending reads; rejection rolls back entry appends and acknowledgements. The
SQLite and PostgreSQL adapters pass the rejection through their transaction boundary, and the
testkit conformance suite covers validator semantics on every backend. The HTTP
package maps rejections to `409 commit_rejected`.
