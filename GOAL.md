# WorldVM operational primitives goal

This file is the durable work plan and progress ledger for the Triplex side of
WorldVM's operational-primitives requests. Update it as work proceeds so a new
session can resume without reconstructing earlier conversations.

## Single goal prompt

Run this prompt from the Triplex repository to start or resume the whole plan:

```text
Start or resume one persistent goal to complete GOAL.md in this repository.
Read its requirements, ledger, and session handoff, then inspect the working tree
and existing PRs before changing anything. Preserve and resume unfinished work.
Treat GOAL.md as the authoritative scope and update it as each item progresses.
Work through every eligible item in order, with one PR per package or TX1 step.
Report each PR and continue automatically; do not stop merely because a PR was
opened. Keep unresolved design decisions in draft PRs, record their blockers,
and continue independent work. Write failing tests first, run the required checks,
and retain reproducible evidence. Do not merge, publish, deploy, edit WorldVM,
or implement RFC-only and issue-only proposals. Mark the goal complete only when
all required deliverables and validation are satisfied; clearly identify anything
still blocked. Before any session ends, update the ledger and exact next action.
```

## Goal and authorization

Complete the implementation, benchmark, RFC, and issue deliverables below in
order. Open one pull request per implementation package, with separate PRs for
each TX1 step. Report each PR, then continue automatically to the next eligible
item. This replaces the original request to stop after each PR and after the
TX1 baseline benchmark. It does not authorize merging, publishing, deployment,
editing WorldVM, or implementing the RFC and issue-only items.

Completion means reviewable PRs, reproducible evidence, an RFC, and filed issues;
it does not require PRs to be merged or packages to be released. Do not declare
completion while required implementation, validation, or external deliverables
remain blocked. Record partial progress and the specific remaining work honestly.

## Context

WorldVM (`bjacobso/worldvm`, branch `onb-next`) vendors Triplex tarballs built from
revision `44892c4` and cannot patch Triplex locally. Its reconciliation engine uses
one Postgres database per world and one home entity per subject, targeting 100,000
subjects and 16 concurrent runners. Each home command commits facts, a receipt,
and outgoing intents in one serializable transaction. Replay needs an exact cut
at an earlier commit position. Sensitive values are sealed by the host with keys
scoped per vault and retention class.

The motivating review was dated 2026-11-10. Treat its code locations, missing-API
claims, and performance concerns as hypotheses to verify against the current
checkout. WorldVM may be read for evidence if available; no WorldVM checkout is
required and none may be edited.

## Execution rules

1. Before changes, read `AGENTS.md`, applicable nested instructions,
   `CONTRIBUTING.md`, `ARCHITECTURE.md`, `docs/current-state.md`,
   `docs/operational-primitives.md`, `docs/roadmap.md`, and
   `docs/sensitive-values.md`. Inspect the working tree and preserve user changes.
2. Follow repository branch, changeset, package-boundary, test, and PR conventions.
   Work sequentially. Use isolated branches/worktrees as needed. Never mix unrelated
   implementation units in one PR.
3. Write the failing regression test before each behavioral change. For unconfirmed
   claims, first produce a confirming or refuting test/benchmark. If refuted, record
   the evidence and skip the unnecessary implementation; continue the goal.
4. Cover every adapter implementing an affected interface, including shared SQL,
   SQLite, Postgres, Cloudflare, and KV/FoundationDB where applicable. Document
   exclusions and actual test coverage; experimental status does not excuse a
   broken shared contract. Keep core browser-safe and use public package exports.
5. Preserve existing public behavior unless a requirement explicitly changes it.
   Add a Changeset for each publishable package change, excluding private packages
   from frontmatter. Call out breaking changes and migration requirements.
6. Do not guess material design decisions left unresolved by this plan or existing
   contracts. Put options and a recommendation in a draft PR. Track the owner
   decision, defer dependent implementation, and continue independent items.
   Routine implementation choices do not need owner approval.
7. Open dependent PRs as an explicit stack when necessary, with correct base
   branches and dependency links. Do not merge earlier PRs to unblock later work.
   Record the integration tip and validate the cumulative stack as well as each
   change. Avoid repeated copies of the progress ledger on diverging branches:
   record its canonical branch/worktree below and maintain it there.
8. Run focused checks first, then `pnpm check` and `pnpm pack:check` for package
   changes. Follow CONTRIBUTING.md for integration gates, including
   `pnpm test:postgres:integration` for temporal, schema, transaction, isolation,
   pagination, Datalog, derivation, and constraint changes. Run FoundationDB's
   opt-in suite for its changes when native infrastructure is available. Record
   unavailable prerequisites and failed checks; never represent them as passing.
9. Use repository-supported local services where available. Preserve evidence in
   reviewable repository files or linked PR artifacts; do not rely on chat alone.
   Benchmarks must record revisions, environment, setup, exact commands, workload,
   sample counts, retries, and raw/summary results. No fabricated measurements.
10. After each PR, record the report specified below and proceed. An unavailable
    service, credential, or owner decision blocks only work that depends on it.
    Do not mark blocked items done or repeat unchanged attempts indefinitely.

## Ordered work ledger

Statuses: `pending`, `active`, `pr-open`, `blocked`, `refuted`, `not-needed`.
`pr-open` requires its acceptance evidence and checks; otherwise describe missing
work explicitly. RFC approval and issue-only work do not authorize implementation.

| Order | Item                                   | Status  | PR / issue / evidence                                                                                       | Dependency or blocker                                                                             |
| ----- | -------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1     | TX8: schema guard and Postgres fixture | pr-open | [PR #59](https://github.com/bjacobso/triplex/pull/59), [report](test/evidence/tx8.md)                       | Browser baseline failures documented                                                              |
| 2     | TX2: public commit-position reads      | pr-open | [PR #60](https://github.com/bjacobso/triplex/pull/60), [report](test/evidence/tx2.md)                       | Based on TX8 PR #59                                                                               |
| 2b    | TX2 read-surface position follow-up    | pr-open | [PR #67](https://github.com/bjacobso/triplex/pull/67), [report](test/evidence/tx2-host.md)                  | Based on #66; host/HTTP/dashboard local checks pass                                               |
| 3     | TX1.1: contention baseline benchmark   | pr-open | [PR #61](https://github.com/bjacobso/triplex/pull/61), [report](test/evidence/tx1-baseline.md)              | Based on TX2 PR #60                                                                               |
| 4     | TX1.2: typed retryable SQL conflicts   | pr-open | [PR #62](https://github.com/bjacobso/triplex/pull/62), [report](test/evidence/tx1-conflicts.md)             | Based on benchmark PR #61                                                                         |
| 5     | TX1.3: late position allocation        | pending | [Draft PR #63](https://github.com/bjacobso/triplex/pull/63), [diagnostic](docs/rfcs/tx1-late-allocation.md) | Owner selected staged ordered-publication investigation after independent packages; proof pending |
| 6     | TX1.4: scoped concurrency, if needed   | pending | [Draft PR #64](https://github.com/bjacobso/triplex/pull/64), [design](docs/rfcs/tx1-scoped-concurrency.md)  | Owner selected database-owned invariant scopes; authority/publication proof and prototype pending |
| 7     | TX4: inbox/outbox                      | pr-open | [PR #65](https://github.com/bjacobso/triplex/pull/65), [report](test/evidence/tx4.md)                       | Based on #64; native FDB unverified                                                               |
| 8     | TX5: cheap preconditions               | pr-open | [PR #66](https://github.com/bjacobso/triplex/pull/66), [report](test/evidence/tx5.md)                       | Based on #65; native FDB unverified                                                               |
| 9     | TX6: filtered transaction feed         | pr-open | [PR #68](https://github.com/bjacobso/triplex/pull/68), [report](test/evidence/tx6.md)                       | Based on #67; root/pack/34 PG pass; native FDB unavailable                                        |
| 10    | TX3: host-sealing/erasure RFC only     | pending | —                                                                                                           | Owner decision before any code                                                                    |
| 11    | TX7: change-journal issue              | pending | —                                                                                                           | Issue only                                                                                        |
| 12    | TX9: BlobStore issue                   | pending | —                                                                                                           | Issue only                                                                                        |
| 13    | Direct-read pagination issue           | pending | —                                                                                                           | Verify current APIs first                                                                         |
| 14    | Canonical-JSON public encoding issue   | pending | —                                                                                                           | Verify existing exports first                                                                     |
| 15    | Datalog valid-time binding issue       | pending | —                                                                                                           | Verify current binding support first                                                              |

### TX8 — Schema-version guard and Postgres fixture

- Verify `layerFromSqlClient` does no DDL and currently permits an incompatible
  schema to reach a raw insert error. Sealed columns arrived in SQL migration v3;
  derive the required version from the current migration source of truth.
- Validate schema compatibility at layer acquisition, before any consumer read or
  write. Export a typed error giving expected and actual versions and directing
  the caller to `runMigrations`. Keep automatic DDL out of this layer.
- Test v2 rejection and current-schema success. Define and test missing-schema and
  newer-version behavior; do not disguise unrelated SQL failures as mismatches.
- Export a testkit fixture that creates an isolated Postgres schema, migrates it,
  supplies a layer, and drops the schema on scoped cleanup, including test failure.
  Keep pooled connections and concurrent tests correctly isolated.
- Convert at least one Triplex Postgres test to the fixture. Verify cleanup and
  isolation. Respect testkit dependency and public-export boundaries.

### TX2 — Public read at a commit position

- Expose `recordedPosition` in the public temporal basis for `entity`, `entities`,
  `match`, and Datalog reads, including relevant wrappers and pagination paths.
  Internal `ResolvedTemporalBasis` already has position support; verify its uses.
- Define whether supplying both `recordedAt` and `recordedPosition` is rejected or
  combined with documented precedence. Preserve valid-time semantics.
- Across every affected adapter, reading position P after later assertions and
  retractions must reproduce the cut observed when P was current at the same
  valid-time basis. Include a property test over random transaction histories.
- Inspect SQL query plans. Add `(entity_id, recorded_position)` only if the plans
  justify it, and publish the plans and any migration/adoption instructions.

### TX1 — Position allocation and unrelated writers

Invariant for every step: positions strictly increase in commit order as observed
by snapshot-isolated readers; no reader sees N+1 while being unable to see committed
N. Preserve rollback semantics, historical cuts, command atomicity, and graph
constraint protection. Do not substitute a sequence that permits visibility holes.
Explain explicitly how each proposed change preserves these properties.

**TX1.1, benchmark-only PR:** test disjoint-entity writers at concurrency 1, 4, and
16 under read committed, repeatable read, and serializable isolation. Investigate
whether the singleton `triplex_commit_position` row lock is retained until the
host's outer commit. Report commits/second, serialization failures, deadlocks, and
where waits occur, separating position contention from other contention. Include
an overlapping host-owned transaction workload representative of WorldVM, explicit
retry accounting, and repeatable runs. Record and report numbers before changing
allocation, then continue automatically under this goal's authorization.

**TX1.2, separate PR:** surface SQL serialization and deadlock failures as typed,
retryable `TransactionConflictError`, distinct from unrelated write failures.
Inspect the existing error type first and extend/reuse it compatibly. Test nested
host transactions and cause propagation. This step remains useful even if the
baseline refutes the allocation concern; do not skip it solely for that reason.

**TX1.3, separate PR if confirmed:** allocate the position as late as safely
possible to shorten lock duration. Existing constraint enforcement relies on global
serialization before checking absence/uniqueness, so moving allocation requires
proof and regression tests that those decisions remain atomic. Benchmark again.

**TX1.4, separate PR only if still needed:** use the scoped-concurrency design in
`docs/operational-primitives.md`: branded `ConflictScope`, atomic multi-scope
claims, successor continuity, and cross-entity invariant protection. Resolve any
remaining architectural choice through a draft PR before implementing it. Require
cross-backend conformance before weakening global constraint serialization.

Completion evidence: rerun the baseline; demonstrate no serialization failures
attributable to position allocation for 16 disjoint writers, with all existing
ordering/replay and constraint tests passing. If this cannot be achieved safely
within the settled design, document the result and remaining blocker rather than
weakening the invariant or claiming success.

### TX4 — Inbox/outbox primitive

- Append inside the caller's transaction with a caller-supplied idempotency key:
  identical key/payload is a no-op; different payload is a typed conflict.
- Define payload equality, key scope, cursor ordering, and transactional behavior
  using existing conventions; expose unresolved material choices in the PR.
- Read pending entries with a cursor and limit for at least an entity scope and
  the entire database. Acknowledge entries while retaining readable history.
- Append, pending-read, and acknowledge must use indexes and never load the whole
  scope. Show behavior/cost with 10 and 10,000 acknowledged prior entries using
  plans or operation counts as well as timings where useful.
- Test atomic rollback with caller writes, concurrent duplicate submissions, and
  a crash after commit but before acknowledgement: redelivery is exactly as stored.

### TX5 — Cheap preconditions

- Add a precondition scoped to one attribute's current value and absence
  preconditions for an entity and/or attribute as required by the public design.
- Define multi-valued attribute comparison and valid-time semantics explicitly;
  distinguish live history from valid-now state consistently with existing guards.
- Check preconditions atomically with writes on every implementing adapter,
  including concurrent insertion/replacement races and complete rollback on failure.
- Demonstrate indexed cost independent of unrelated entity attributes/history;
  do not implement the guards by materializing the entire entity or history.

### TX6 — Entity-filtered transaction feed

- Add entity-ID-prefix or entity-type filtering to `transactions({ after, limit })`,
  preserving feed ordering and cursor semantics. Clarify type membership timing,
  multiple matching entities, duplicate suppression, and empty-page advancement.
- Return exactly the subsequence of the global feed touching matching entities,
  with complete authoritative transaction records and no unrelated feed scan.
- Verify existing `transactionsForEntity` and changed-entity indexes first; they
  may supply foundations but do not automatically satisfy prefix/type catch-up.
- Test against the global-feed oracle and show index/query-plan evidence.

### TX3 — Host-sealed values and erasure RFC; no implementation

Write a standalone RFC PR comparing:

1. Caller-sealed envelopes with caller-supplied blind tokens: trust boundary,
   validation, guarantees, non-guarantees, equality/joins, uniqueness, rotation,
   and exposure across raw reads, journal copies, snapshots, and derived data.
2. WorldVM adopting Triplex's `KeyProvider` through a custom provider supporting
   vault and retention scoping: current feasibility and necessary contract changes.

Explain how each interacts with blind-token scrubbing and journaled erasure facts,
including the copies/indexes that must be scrubbed and post-erasure semantics.
Recommend one option and list the owner's explicit decision. Host sealing reverses
the documented client-sealing non-goal: opening an RFC is completion of this item;
no code is authorized without a subsequent owner decision.

### Issue-only follow-ups — no implementations

Search existing issues and current APIs before filing. Link/update an existing
issue when it covers the request. If a premise is refuted, record supporting
exports/tests/docs instead of filing a misleading missing-feature issue.

- **TX7:** investigate `:_tx/change` value duplication and the reported five
  history rows per business assertion. File an ID-only change-mode proposal with
  replay/audit trade-offs. Measure existing row/byte overhead and estimate the
  ID-only savings from representative stored payloads, distinguishing estimates
  from measured performance. Include a benchmark plan for the proposed mode;
  do not implement it or silently treat the row-count claim as fact.
- **TX9:** file the browser-safe, content-addressed streaming `BlobStore` port
  already proposed in operational primitives; durable S3/R2 adapters stay outside
  core, with read verification and retention/reachability considerations.
- **Pagination:** assess `match`, `entity`, `entities`, and `history` individually;
  account for existing `entityPage` and Datalog pagination. File the remaining gap.
- **Canonical JSON:** verify public content encoding exports and their precise
  semantics. File only the remaining reusable encoding/API/documentation gap.
- **Datalog valid time:** verify binding support for `validFrom` and `validTo` and
  file the remaining gap with a consumer query and temporal semantics.

## Required report for every PR

Record a durable report here or in a linked repository artifact, and use it in the
PR description and user update:

- PR URL, branch/base, dependency links, and commit tested.
- Problem, final public API, and before/after consumer examples.
- Adapter coverage matrix, including untested or excluded paths and reasons.
- Regression/property/concurrency tests and benchmarks: exact commands, results,
  evidence paths, service versions, and any missing prerequisites.
- Refuted premises or changed scope, with evidence.
- Consumer adoption steps, required migrations, compatibility/breaking changes,
  and the Changeset.
- Unresolved design decisions, options, recommendation, and work they block.

For benchmark-only, RFC, and issue deliverables, mark API/migration fields as
not applicable rather than implying an implementation exists.

## Session handoff

- Canonical ledger: this checkout, currently `feat/tx6-entity-filtered-feed`. Carry the
  ledger forward on the integration tip as the PR stack grows. Initial plan commit
  is also preserved on `goal/worldvm-operational-primitives` (`c59d7d9`).
- Active item: TX3 RFC only, next in sequence. TX6 is PR #68 with clean SQL/KV
  evidence and passing root, package and 34-test PostgreSQL checks. Hosted CI pending.
- Integration tip / PR stack: `feat/tx6-entity-filtered-feed`, based on
  `fix/tx2-host-position-basis` (#67), based on
  `feat/tx5-cheap-preconditions` (#66), based on
  `feat/tx4-operational-entries` (#65), based on
  `design/tx1-scoped-concurrency` (#64), based on
  `design/tx1-late-allocation` (`75d8ef6`, draft #63), then #62 → #61 → #60 → #59.
- Next action: branch from TX6 for TX3 host-sealing/erasure RFC; inspect actual
  KeyProvider, ValueCodec and raw sealed-storage contracts. No runtime implementation.
  Then file verified issue-only deliverables before TX1 protocol investigation.
- Decisions: owner chose investigation of staged ordered publication with
  database-owned invariant scopes. Investigate it after independent deliverables.
  Strict ordering, coherent older-writer snapshots and mandatory invariant scope
  authority remain proof obligations. Do not weaken them or treat the direction
  choice as proof that an implementable protocol exists.
- External blockers: none. Docker and GitHub authentication are available. Browser
  screenshot baselines fail on untouched main as described in the TX8 report.
  FoundationDB native coverage is unavailable: `libfdb_c.dylib` is absent; its
  opt-in suite skips without running tests. Shared KV behavior is tested in memory.

Append dated progress entries below. Update the ledger and handoff before ending
a session, after each PR/issue, and whenever evidence changes a decision. Resume
existing work instead of recreating branches, PRs, benchmarks, or issues.

### 2026-11-10 — Plan created

Captured the complete requested sequence and acceptance criteria. No code changes,
tests, benchmarks, PRs, or issues have been completed as part of this goal yet.

### 2026-11-10 — TX8 implementation and validation

Added the acquisition-time schema guard and isolated testkit Postgres fixture;
converted the sensitive-value Postgres tests to the fixture. The v2 regression
failed before implementation and passed afterward. All 26 Postgres integration
tests and `pnpm check` pass. Tarball validation passes; the updated packed consumer
also checks the new fixture subpath and error API. Browser tests return 9 passed,
4 screenshot failures, reproduced with the same tests on untouched `main` in
`/tmp/triplex-tx8-baseline`. See [the report](test/evidence/tx8.md) for commands,
coverage, API examples, and adoption requirements.

TX8 opened as [PR #59](https://github.com/bjacobso/triplex/pull/59), implementation
commit `105b37a`. The GitHub connector returned a permission error; authenticated
`gh pr create --body-file /tmp/triplex-tx8-pr-body.md` succeeded. No merge or release
was performed. Continue with TX2 on a dependent branch.

### 2026-11-10 — TX2 implementation

Public position reads and page cursors now preserve an exact cut. Requests giving
both recorded timestamp and position are rejected. Generated histories compare
complete fact bodies and Datalog results, including joins and negation; a separate
fixed-clock test distinguishes same-millisecond commits. Position reads hide later
retraction metadata without changing full audit reads. Position-only page snapshots
omit their timestamp, and persisted derivations retain the position basis.

Plan evidence justified a composite index: Postgres scanned 20,000 rows for ten
results before it, versus ten indexed candidates afterward. SQL migration v4 and
Cloudflare v5 add it. See [the report](test/evidence/tx2.md) and
[raw plans](test/evidence/tx2-plans.json). Final cumulative checks are in progress.

TX2 final checks pass: `pnpm check` (including 745 core tests and native workerd
conformance), `pnpm test:postgres:integration` (27 passed), and `pnpm pack:check`
(11 tarballs and a clean consumer). FoundationDB's native suite was attempted but
skipped due to its missing client library; no native pass is claimed.

TX2 opened as [PR #60](https://github.com/bjacobso/triplex/pull/60), tested
implementation `735e05c`, with base branch `feat/tx8-schema-guard`. TX8's GitHub CI
is green on Node 22 and 24, package-consumer, stress-smoke, docs-e2e, Postgres
integration, and docs preview. Its local screenshot mismatch is environment-specific.

TX2's initial hosted verification caught a report-only TypeScript fence with
`yield*` outside a generator, added after the successful local root check. Wrapped
that fragment in `Effect.gen` and rechecked the Markdown; product code is unchanged.

### 2026-11-10 — TX1.1 baseline measured

Added an opt-in private stress harness, then ran the complete 1/4/16-writer,
three-isolation matrix three times without retries, with 5 ms and zero post-call
host hold. Both runs used clean measured source `32a3360`, preserved on remote
branch `bench/tx1-baseline-source`. The benchmark branch then rebased on TX2's
report-only fix; no measured product behavior changed.

Each run attempted 9,450 commands, committed 4,050, and recorded 5,400 serialization
failures with no deadlocks. Every serialization failure was at position allocation.
At 16 writers, repeatable read and serializable each rejected 2,250 of 2,400
attempts across repetitions in both workloads. The 5 ms baseline median rates at
1/4/16 writers were 85.5/94.8/97.0 commits/s for read committed,
89.6/84.9/80.4 for repeatable read, and 97.6/84.3/78.7 for serializable.
Up to 15 workers blocked at once, overwhelmingly on the allocator statement.

All sampled journal-prefix checks and final atomicity counts passed. `pnpm check`,
`pnpm pack:check`, and the stress harness typecheck pass. See the
[report](test/evidence/tx1-baseline.md) and linked raw data for exact commands,
environment, counts, limitations, and the zero-hold comparison. TX1.2 is justified;
shortening lock duration alone must not be confused with fixing snapshot conflicts.

TX1.1 opened as [PR #61](https://github.com/bjacobso/triplex/pull/61). TX2's
post-documentation-fix CI reached its tests, where the expanded full suites exceeded
Vitest's default five-second budget on SQLite and the Cloudflare public builder.
The individual assertions pass locally; the aggregate suites need explicit budgets
consistent with the existing 30-second full-corpus test in testkit. This repair
precedes TX1.2, and no replay coverage will be removed.

The aggregate-suite budget fix is committed as `9995d96` on TX2 and carried into
the benchmark branch by rebase. `pnpm check` passes after that fix; assertions and
generated-history coverage are unchanged. Hosted verification is pending again.

### 2026-11-10 — TX1.2 typed conflicts

TX2 and the benchmark now have green hosted CI, including Node 22/24, package
consumer, Postgres integration, docs/browser, and stress-smoke checks.

Added structured Postgres serialization/deadlock conversion and
`PgTriples.withTransaction` for the host's outer boundary. Existing precondition
conflicts expose `isRetryable: true`; convenience writes and the sensitive layer
preserve the distinct error. Tests failed first with the old `WriteError` behavior,
then passed with typed conflicts and rollback, including a failure deferred until
the outer commit. `pnpm check` and all 29 Postgres integration tests pass. See
[the report](test/evidence/tx1-conflicts.md); package validation is next.

`pnpm pack:check` also passes for TX1.2 (11 tarballs and a clean consumer), including
the new public helper signature. Preparing the PR and a real-concurrency smoke run.

The TX1.2 smoke ran at clean implementation `7b37148`: nine configurations,
81 commits, 108 serialization failures at allocation, no deadlocks/retries, and all
atomicity/visibility checks passed. Raw evidence is in
`test/evidence/tx1-conflicts-smoke.json`. This confirms error classification changes
without claiming that allocation contention has been fixed.

TX1.2 opened as [PR #62](https://github.com/bjacobso/triplex/pull/62), implementation
`7b37148`, smoke/evidence `9eaae58`, based on PR #61. The complete stack is
#59 → #60 → #61 → #62; nothing has been merged or published. TX1.3 and later items
remain required. All local TX1.2 checks pass; hosted checks are pending.

### 2026-11-10 — TX1.3 diagnostic and decision gate

TX1.2 now has green hosted CI on all checks. Added a deterministic SQL diagnostic
with separate disjoint host tables: the older snapshot fails at its final counter
upsert even after the first writer has committed and released its lock. It passes
at repeatable read and serializable without sleeps or planted errors. All 30
Postgres integration tests and `pnpm check` pass. No allocator was changed.

The current adapter requires final positions for every mutation, and global
serialization precedes entity-state/graph checks. A true tail allocation therefore
needs an unsettled staging and invariant-serialization protocol. Per execution
rule 6, the [TX1.3 draft](docs/rfcs/tx1-late-allocation.md) records options and the
recommendation to settle global ordering with TX1.4 first. Implementation remains
blocked on that decision; the strict zero-failure target is not achieved. This
does not block the independent remaining packages.

TX1.3's options and diagnostic opened as [draft PR #63](https://github.com/bjacobso/triplex/pull/63),
tested source `074dde8`, based on #62. This is a decision checkpoint, not completion
of the allocator change. Continue with TX1.4's conditional design assessment.

### 2026-11-10 — TX1.4 decision gate

The existing scoped-concurrency sketch does not settle mandatory scope derivation
for mixed constraint versions/all writers, or a global publication protocol that
removes the shared updater while preserving native ambient snapshots. The
[proposal](docs/rfcs/tx1-scoped-concurrency.md) gives concrete options, recommendations,
older-writer visibility obligations, and cross-backend proof gates. Scope heads
alone cannot fix the demonstrated final-counter conflict. No scope API, schema,
allocator, or constraint behavior was changed. `pnpm check` passes with 37 docs pages.
TX1.4 remains blocked on its owner decisions; proceed independently with TX4.

TX1.4 opened as [draft PR #64](https://github.com/bjacobso/triplex/pull/64), tested
documentation `873f193`, based on draft #63. This is not a completed scoped runtime.
The active goal continues with independent inbox/outbox work under the existing
serialized transaction guarantees.

### 2026-11-10 — TX4 transactional entry implementation

The initial portable test failed because `Outbox.append` was absent. Inbox/outbox
operations now compose with facts in `transact`; canonical payload deduplication,
non-retryable payload conflicts, bounded scoped/global pending pages, acknowledgement
history, same-transaction consume, concurrent keys, rollback, cursor binding, and
control-character identity cases pass across the shared suites. SQL migration v5
and Cloudflare v6 add independent operational storage and pending-only indexes.

`pnpm check` and `pnpm pack:check` pass, including real workerd and 11 tarballs with
a clean consumer using the new API. PostgreSQL's 31-test suite passed before the
additional ambient outer-transaction test, which passes separately. The final full
32-test run and clean-revision query-plan evidence will be recorded in the report.
KV operation-count tests show the same bounded reads/writes with 10 and 10,000
acknowledged records; native FoundationDB remains unavailable. No TX4 PR yet.

TX4 implementation checkpoint is `23e0c44`. Both SQL index fixtures ran sequentially
on that clean revision; raw plans and illustrative timings are retained in
`test/evidence/tx4-{sqlite,postgres}-plans.json`. At 10,000 acknowledged records,
PostgreSQL's primary lookup returns one row and pending index ranges return only
the bounded candidates. KV entry operation counts are identical at both history
sizes. The final full PostgreSQL suite passes all 32 tests, and package validation
passes all 11 tarballs plus the consumer. See [the report](test/evidence/tx4.md).

TX4 opened as [PR #65](https://github.com/bjacobso/triplex/pull/65), based on #64,
implementation `23e0c44` and evidence `2ce96f3`. Final `pnpm check`, `pnpm pack:check`,
and all 32 PostgreSQL integrations pass. The complete stack is #59 → #60 → #61 →
#62 → #63 (draft) → #64 (draft) → #65. Hosted verification is pending. Continue
with TX5; no merge, release, or WorldVM edit was performed.

### 2026-11-10 — TX5 in progress

The portable regression failed first because a wrong attribute-value precondition
was ignored (`/tmp/triplex-tx5-red.log`). `AttributeValue` (exactly one live fact),
`AttributeAbsent`, and `EntityAbsent` now run before mutation within the existing
serialized boundary. They include all unretracted valid times, consistent with
EntityState. Canonical equality and sensitive blind-token preparation are shared.
Concurrent value replacement, absent insertion, entity creation, rollback and
future-valid/retracted cases pass in the portable suites. `pnpm check` and the
32-test PostgreSQL suite passed before the latest plan fixture was added.

SQL has existing partial live indexes, but the new 10/10000-history fixture found
PostgreSQL choosing a sequential scan under skewed attribute/retraction statistics.
The diagnostic is testing extended statistics before deciding whether a migration
is required. Do not claim indexed cost is proved yet. KV now maintains an extra
live-only ID index without removing historical keys. Existing stores explicitly
backfill in bounded resumable batches after upgrading all writers; new stores are
ready automatically. Tests pass for resume, upgraded mutations between batches,
and bounded reads at 10 and 10,000 historical replacements and unrelated attributes.
Further migration safety, final validation, documentation/Changeset and PR remain.

A TX2 follow-up also needs a regression: `packages/host/src/Protocol.ts`'s
`queryOptions` copies recordedAt/validAt but omits recordedPosition. Verify the host
Datalog path and fix it in a separate TX2 follow-up PR; do not treat broad core
position tests as proof of wrapper coverage.

TX5's extended-statistics experiment did not give sufficiently selective lookup:
it scanned 1,000 unrelated entities on the same attribute. A PostgreSQL-only live
expression index plus a length-framed entity/attribute predicate fixes that case;
SQL migration v6 creates it and analyzes triples. SQLite/Cloudflare retain their
existing live compound indexes. The 10/10000 plan fixtures now pass. New KV tests
also prove batch rollback on corrupt input and rejection of unknown index versions.
Plaintext guards without blind equality fail closed, while exact stored-envelope
comparison remains supported. Final report, clean evidence, cumulative checks and
PR are still pending; no TX5 completion is claimed yet.

TX5 final cumulative `pnpm check` and all 33 PostgreSQL integration tests pass,
including the selective PostgreSQL lookup and the sensitive/raw-storage suites.
Four KV migration/cost tests and the explicit no-blind guard test pass. An
implementation checkpoint is next, followed by clean-revision plan capture,
package validation and the PR. No TX5 PR has been opened yet.

TX5 implementation checkpoint `6673197` is cleanly measured in
`test/evidence/tx5-{sqlite,postgres}-plans.json`. PostgreSQL's value lookup returns
one row with zero filtered candidates and three shared buffer hits at both history
sizes; missing attribute/entity checks return zero candidates. Root checks and
all 33 PostgreSQL integrations pass; the final packed consumer is in progress.

TX5 package validation passes: 11 tarballs and a clean consumer compile the new
preconditions and `KvTriples.migrateLiveFacts`. Preparing the PR based on #65.

TX5 opened as [PR #66](https://github.com/bjacobso/triplex/pull/66), implementation
`6673197`, evidence `e1e9010`, adoption clarification `4a515e0`, based on #65.
Root checks, all 33 PostgreSQL integrations, and 11 packed tarballs/clean consumer
pass. Hosted checks are pending. Continue with the discovered TX2 host boundary
regression in a separate follow-up PR, then TX6. No merge or release was performed.

### 2026-11-10 — TX2 host boundary follow-up

The decoded KV and SQLite tenant-boundary tests both failed first: a historical
Datalog request returned Alicia/Carol from later commits. The host mapper now
uses TemporalBasis and forwards recordedPosition. Eight host tests pass,
including Query/QueryPage, continuation, position zero, authorization/identity,
and rejection of ambiguous timestamp+position. Root/package/PostgreSQL checks
are next; no follow-up PR yet. See [the report](test/evidence/tx2-host.md).

The TX2 host follow-up passes `pnpm check`, all 33 PostgreSQL integrations,
and `pnpm pack:check` (11 tarballs plus clean consumer). TX5's hosted CI is also
now green on every check. Preparing the host follow-up PR, then TX6.
An asynchronous owner question was sent about allocator drafts #63/#64; no answer
or approval is assumed. Independent work continues.

### 2026-11-10 — Owner direction and expanded TX2 wrapper audit

The owner answered the pending allocator question: "Investigate staged ordered
publication with database-owned invariant scopes (recommended)" after independent
packages. This resolves the directional decision behind drafts #63/#64 and queues
that investigation/prototype; their production allocator targets remain unmet.
The required ordering and snapshot guarantees are unchanged. No design is marked
proved or implementation complete merely because this direction was selected.

Host follow-up opened as [PR #67](https://github.com/bjacobso/triplex/pull/67),
initial host implementation `80ab675`. The broader wrapper audit found HTTP's
entity/list URI parser and dashboard fact/page helpers also omitted position.
HTTP KV/SQLite historical reads failed first (Alicia instead of Alice), and the
dashboard historical test included later entities. Focused corrected tests now
pass. #67 is being expanded to include these TX2 corrections, validated position
URI parameters/OpenAPI, and compatible dashboard cursors. Final root/package/
PostgreSQL validation and report/PR rewrite remain before marking it pr-open.

The expanded #67 scope passes focused HTTP KV/SQLite regressions and three
Dashboard position/cursor cases. HTTP's generated OpenAPI tests pass after adding
the optional parameter to v1/v2/latest fixtures. Final `pnpm check` and all 33
PostgreSQL integrations pass for the expanded implementation. Package validation
and PR/report rewrite remain. Owner direction was also recorded on draft PRs
#63 and #64 without marking their protocols or allocator changes complete.

The expanded TX2 follow-up #67 is validated at implementation `20d26d9`:
`pnpm check`, all 33 PostgreSQL integrations and `pnpm pack:check` (11 tarballs and
clean consumer) pass. The report covers the host, HTTP and dashboard scope, before/
after examples, exact commands, direct versus shared adapter coverage, new HTTP
parameter/OpenAPI, compatible dashboard cursors and adoption with no new migration.
Continue TX6, then the RFC and issues; investigate the selected allocator direction
after those independent deliverables. Hosted checks will be monitored as work proceeds.

### 2026-11-10 — TX6 prefix-filtered feed in progress

The portable global-oracle regression failed first because entityIdPrefix was
ignored (`/tmp/triplex-tx6-red.log`). Prefix reads now retain complete records,
deduplicate transactions touching several matching entities, preserve global
position ordering and resume tokens, and handle case/literal wildcard/Unicode
prefixes. The same case passes on KV, SQLite and Cloudflare harness/workerd.
The tenant protocol forwards the new field; its focused regressions pass after
fixing its test config to actually invoke workspaceAliases (avoiding stale dist).

KV reuses the changed-entity AVET prefix, pins a head, and retains only bounded
candidate IDs before hydrating matching journals. Its I/O test sees the same six
matching candidates and no unrelated transaction metadata with 10 and 10000
unrelated commands. It still scans matching prefix history, so do not claim
history-independent filtered-cursor work. SQL uses literal binary/C prefix bounds
and a position predicate. A v7 covering index is under plan validation; SQLite's
small fixture chooses its existing idx_ref_target range. Keep only indexes justified
by the larger plans. A PostgreSQL focused plan case passes; full native/root/package
validation, migration/adoption docs, Changeset and PR remain. No TX6 PR yet.

TX6's large SQLite plan also prefers its existing idx_ref_target range, which
selects only matching references. Removed the redundant SQLite/Cloudflare index
DDL: SQL v7 is PostgreSQL-only covering-index creation plus ANALYZE; SQLite records
v7 with no extra DDL, and Cloudflare needs no migration beyond v6. Full PostgreSQL
integration passes all 34 tests, including the global-oracle corpus and cost fixture;
Cloudflare passes its native harness and real workerd suites. Root checks pass
before the latest quote/surrogate case and evidence-writer additions. Final
validation, clean evidence, report and PR remain.

TX6's migration/adoption docs and Changeset are written. The final implementation
uses PostgreSQL SQL v7 only (C-collation covering index plus ANALYZE), records v7
without DDL on SQLite, and leaves Cloudflare's schema at v6. The report at
`test/evidence/tx6.md` explicitly distinguishes no unrelated-envelope reads from
matching-history scan cost. Final root/native checks include added quote/backslash
and maximal-surrogate cases and evidence writers; package checks, clean-revision
artifacts and PR preparation follow.

The added SQL receipt validation caught invalid synthetic IDs/change fields in the
cost fixture. Replaced them with valid deterministic ULIDs and tripleId-bearing
changes, then verified the noise receipt through Triplex. Both focused SQL plan
cases now pass, followed by final `pnpm check` and all 34 PostgreSQL integrations.
Preparing a clean implementation checkpoint and retained plan/I/O artifacts; no
TX6 PR is open yet.

TX6 implementation checkpoint `de5703f` has clean KV/SQLite/Postgres evidence.
KV visits six references and 22 metadata rows at both unrelated-history sizes.
Postgres uses the covering index at 10000 commands (six candidates); SQLite uses
its existing reference index. Package validation verifies 11 tarballs and a clean
consumer. FoundationDB opt-in skips for absent native client. Opening TX6 PR next.

TX6 opened as [PR #68](https://github.com/bjacobso/triplex/pull/68), based on #67.
Independent work continues with TX3 RFC only; allocator direction remains queued.
