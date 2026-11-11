# TX1.3: late allocation needs a transaction protocol decision

Update after owner direction: The owner selected staged ordered publication with database-owned invariant
scopes. The [follow-up investigation](./tx1-ordered-publication-investigation)
now tests that direction and exposes an older-writer own-snapshot hole. The
remaining owner decision concerns pending receipts and a committed-only reader
boundary, rather than whether to investigate the direction. The original options
below are retained as design history; production allocation remains unchanged.

Status: **proposal requiring an owner decision; no allocator change implemented**.
This is the TX1.3 checkpoint in the WorldVM operational-primitives goal. It follows
the contention baseline and typed conflict work in PRs
[#61](https://github.com/bjacobso/triplex/pull/61) and
[#62](https://github.com/bjacobso/triplex/pull/62).

## Evidence and recommendation

Moving the counter update later can shorten part of a lock's lifetime, but it does
not by itself remove snapshot conflicts. The recorded 16-writer baseline rejected
2,250 of 2,400 attempts at either repeatable read or serializable isolation, with
the same counts in the zero-hold control. The measured workload and limitations
are in [the baseline report](https://github.com/bjacobso/triplex/blob/bench/tx1-position-contention/test/evidence/tx1-baseline.md).

A new deterministic Postgres test establishes an older snapshot in transaction B,
writes B's own host table, then lets A update a different host table and commit
its counter update as its **final SQL statement**. B then issues the same final
counter upsert. B still receives a serialization conflict, and its host write
rolls back. This passes at both repeatable read and serializable isolation, without
timed sleeps, a held allocator lock, shared host-table predicate locks, or planted
errors. The SQL experiment uses a separate synthetic counter and does not mutate
Triplex's production allocator or journal.

This matches PostgreSQL's rule for updating rows changed since a repeatable-read
snapshot, and its stronger serializable behavior. It is a snapshot freshness
problem as well as a lock-duration problem.
[PostgreSQL 17 isolation documentation](https://www.postgresql.org/docs/17/transaction-iso.html)
explains why retrying the complete transaction is required. Moving a row update
to the end also does not release its lock before the enclosing transaction ends.
See [PostgreSQL's locking documentation](https://www.postgresql.org/docs/17/explicit-locking.html).

**Recommendation:** retain the current allocator and TX1.2's typed retry boundary
while deciding the TX1.4 global ordering protocol. Do not introduce temporary
positions or weaken the serialized invariant checks as an incidental optimization.
A narrower late-allocation optimization can follow if its staging contract and
measured benefit are approved; it must not be reported as resolving the 16-writer
serialization requirement.

## What the current contracts require

The current `StorageAdapter.insert`, `batchInsert`, and `retract` operations all
receive their final position. Facts, retraction visibility, journal envelopes,
pagination, and dependency state rely on those positions being atomically stored.
The shared SQL service allocates before checking entity-state and graph constraints.
The KV service follows the same check/mutate atomic boundary. Existing concurrent
absence and uniqueness decisions depend on that ordering.

Consequently, allocating after writes is not a local movement of one statement:

- SQL and KV mutation contracts need a way to stage and finalize positions.
- All staged assertion/retraction indexes must be finalized before commit, including
  journal metadata and in-transaction reads.
- Preconditions and cross-entity constraints need an equivalent serialization or
  scope-claim mechanism before their reads. A final counter update alone cannot
  protect an earlier absence or uniqueness check from a concurrent writer.
- A nested Triplex call returns its receipt before the host commits. Triplex cannot
  shorten host work after that return by moving statements within the nested call.

These are public runtime/storage decisions, not an established contract in the
current adapter interface. This proposal does not claim that no alternative
protocol could satisfy the goal; it identifies what a local relocation cannot do.

## Options for the owner

| Option                                                                           | Benefit                                                                | Cost / remaining limitation                                                                                                     | Ordering and constraints                                                                          |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A. Keep allocation unchanged while designing TX1.4                               | Preserves existing composition; typed conflicts are available now      | Contention and higher-isolation failures remain; TX1 is incomplete                                                              | Existing guarantees retained                                                                      |
| B. Approve a staged-mutation/finalization contract, with an early invariant gate | Could reduce the allocator window for eligible read-committed commands | Cross-backend schema/index/rollback work; the gate may remain contended; final counter updates still fail against old snapshots | Must prove equivalent invariant protection and finalization before exposing a receipt             |
| C. Opt-in host commit admission before the transaction's first snapshot          | Can avoid beginning overlapping snapshots behind one shared updater    | Serializes unrelated transactions and requires explicit host participation; does not meet the concurrency objective             | Must be designed before host SQL/reads begin; cannot be retrofitted inside an ambient transaction |

Choose **A** for the current implementation, and authorize a concrete ordering
protocol investigation for TX1.4. Choose B only if its narrower read-committed
benefit is worth a separate public staging API, with explicit scope and acceptance
criteria. C is a possible operating mode, not the requested parallel-writer fix.

An ordinary sequence is not an admissible shortcut: one writer can reserve N and
remain uncommitted while another commits N+1. Rollback can also leave reservations
unused. Sequence identity is not ordered publication, and would violate the stated
snapshot/commit-position invariant. The non-transactional behavior is documented in
[PostgreSQL sequence functions](https://www.postgresql.org/docs/17/functions-sequence.html).

## Required decision and blocked work

The owner must decide whether to keep TX1.3 coupled to the TX1.4 ordering design
(recommended), or approve a narrower staged-write optimization and its contract.
Until then, production late allocation is **not implemented**, the zero-failure
16-writer target remains unmet, and no allocation/constraint guarantee is weakened.
This draft does not authorize a change in position semantics or isolation level.

Any implementation must first add failing cross-adapter tests for finalization,
read-your-writes, abort/savepoint cleanup, preconditions, cross-entity uniqueness,
reference targets, and exact historical reads. Then rerun the full TX1 baseline
with the same settings and report both failures and waiting. A shorter measured
lock window alone is not evidence of eliminating snapshot conflicts.

## Verification and compatibility

Exact diagnostic command:

```sh
pnpm --filter @triplex-build/triplex-postgres exec vitest run test/integration/postgresql.test.ts -t 'final-statement counter'
```

It passes both isolation cases on Postgres 17.8 in the existing testcontainer
fixture. `pnpm test:postgres:integration` passes all 30 tests and `pnpm check`
passes, including the new documentation page and 36 local llms links. An initial
docs build caught a link to evidence outside the published docs root; it now uses
the repository evidence URL. This is a reproducible mechanism test, not a
throughput measurement or a replacement for the 1/4/16-writer benchmark. There
has been no new allocation implementation to benchmark.

The PR changes only the diagnostic test and this proposal. Public API before/after:
unchanged. Consumer adoption and migration: none. Postgres supplies the mechanism
evidence; SQL, SQLite, Cloudflare, KV, and FoundationDB runtime implementations are
unchanged. The native FoundationDB limitation recorded in the goal still applies.
An empty Changeset records this non-publishable design/test checkpoint.
