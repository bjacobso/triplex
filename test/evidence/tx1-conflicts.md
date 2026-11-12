# TX1.2: typed retryable transaction conflicts

Date: 2026-11-10. Branch: `feat/tx1-retryable-conflicts`, based on benchmark
[PR #61](https://github.com/bjacobso/triplex/pull/61). This changes error reporting;
it does not change allocation, isolation, locking, or automatic retry behavior.
PR: <https://github.com/bjacobso/triplex/pull/62>. Implementation tested: `7b37148`.

## Public API and adoption

Previously, native Postgres serialization/deadlock errors from Triplex were wrapped
in `WriteError`, requiring consumers to inspect nested causes for SQLSTATE 40001
or 40P01. Host-owned outer-commit errors could escape after the nested Triplex call
had already returned.

Now `TransactionConflictError` carries `isRetryable: true`, an optional `reason`
(`serialization` or `deadlock`), and the original `cause`. Existing precondition
conflicts retain their identity and now expose the same retryability flag.
Classification uses Effect SQL's structured reasons, not message text or arbitrary
raw `code` fields. Cause traversal handles arbitrary depth and terminates on cycles.

Before, the host transaction boundary was:

```ts
const result = sql.withTransaction(command);
```

After, use the Postgres helper at the outermost host boundary:

```ts
const result = PgTriples.withTransaction(command);
const handled = result.pipe(
  Effect.catchTag("TransactionConflictError", (error) =>
    hostRetryPolicy(error.reason, error.cause),
  ),
);
```

Reload state and retry the complete host transaction according to host policy;
do not retry inside an aborted transaction. The helper uses the ambient
`SqlClient`, keeps its fiber-local transaction/savepoint behavior, and creates no
pool. It covers host statements and the outer commit. Other host SQL and domain
failures remain their original objects. Direct `sql.withTransaction` is still
available with its existing SQL error channel.

`transact`, `assert`, `assertBatch`, `retract`, and `retractByPattern` preserve
native conflicts as this distinct type. The sensitive decorator preserves it too.
No arbitrary write failure, constraint violation, malformed SQL, or connection
failure is converted merely because it might be retryable.

This is a pre-1.0 error-channel change: convenience write/adapter transaction
signatures widen to include `TransactionConflictError`, and `OverlayError` follows
the assertion contract. Consumers with explicit error annotations must include
the new case. Consumers catching only `WriteError` for SQL conflicts should catch
`TransactionConflictError` instead. No migration is required. The Changeset marks
core and Postgres minor and the conformance testkit patch.

## Invariant and adapter coverage

Allocation and data mutation code are unchanged. Conversion runs on the failed
transaction effect after Effect SQL has handled rollback. Tests demonstrate that
facts, command receipts, host rows, and positions remain rolled back, including
when failure occurs at the outer commit. This preserves the existing ordering
invariant: a snapshot reader cannot see N+1 without committed N. TX1.1's throughput
and contention remain problems to address separately; typed errors do not fix them.

| Adapter / surface       | Coverage                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres                | Native driver SQLSTATEs 40001/40P01 at allocation, typed write helpers, sensitive wrapper, deferred outer-commit failure, rollback, unrelated SQL/domain errors |
| Shared adapter contract | Allows typed transaction conflicts in addition to `WriteError`; TypeScript checks every implementation                                                          |
| SQLite / Cloudflare     | Existing SQL services use the widened core contract; their precondition conflicts expose the flag; shared conformance and Cloudflare workerd run in root checks |
| KV                      | Convenience methods preserve conflicts; shared conformance asserts retryability on stale preconditions                                                          |
| FoundationDB            | Shared KV code applies, but native suite remains unavailable because `libfdb_c.dylib` is missing (attempt recorded in TX2); no native result is claimed         |

Only Postgres translates these native SQL reasons. This does not add a claim that
SQLite busy/lock timeouts or FoundationDB native errors have been normalized.

## Test-first evidence and checks

- `pnpm --filter @triplex-build/triplex/postgres exec vitest run test/transaction-conflict.test.ts`:
  failed before the normalizer existed, then passed. Cases cover structured
  serialization/deadlock reasons through 12 wrappers, unrelated errors, cycles,
  and existing precondition conflicts.
- `pnpm --filter @triplex-build/triplex/postgres exec vitest run test/integration/postgresql.test.ts -t 'surfaces SQL transaction conflicts'`:
  failed with `WriteError` before conversion. A trigger raises each native SQLSTATE
  at the real allocator statement, through the real driver. After conversion it
  passes with complete rollback and typed errors on every convenience method and
  through the sensitive decorator. Convenience methods were observed failing this
  expectation before their wrappers were changed.
- A separate integration test uses a deferred constraint trigger to raise 40001
  **at outer commit**, after setting a flag proving the nested Triplex call returned.
  `PgTriples.withTransaction` reports the conflict and all host/Triplex effects
  roll back. Malformed SQL stays `SqlError`; a host domain error is preserved by
  identity.
- `pnpm check`: passed, including all shared adapter suites and real workerd.
- `pnpm test:postgres:integration`: 29 passed.
- `pnpm pack:check`: 11 tarballs and a clean external consumer passed, including
  the new host-transaction helper's public type signature.
- `git diff --check`: passed.

The Postgres tests use the same macOS/Node v24.13.0/pnpm 10.11.0/Effect 4.1.1 and
Postgres 17 testcontainer environment as TX1.1. The planted SQLSTATE tests verify
classification/rollback deterministically; they are not claims of a naturally
occurring deadlock. TX1.1 independently demonstrated actual serialization races.

The benchmark harness's failure-location extraction now follows cause wrappers so
new typed errors do not hide the original allocation location in subsequent runs.
No performance improvement is claimed. Package validation and any final smoke
results are recorded in `GOAL.md` before opening the PR.

Real-concurrency smoke after implementation:

```sh
TX1_BENCH_COMMANDS=3 TX1_BENCH_REPETITIONS=1 TX1_BENCH_OUTPUT=../evidence/tx1-conflicts-smoke.json pnpm --filter triplex-stress benchmark:positions
```

At clean implementation revision `7b37148`, all nine configurations and atomicity/
visibility checks passed. There were 81 commits, 108 serialization failures,
zero deadlocks, and zero retries. Every failure retained its
`40001:position-allocation` location through the new typed wrapper. See
[the raw smoke report](tx1-conflicts-smoke.json). Counts match the baseline smoke;
the run verifies classification and unchanged contention, not throughput gains.
