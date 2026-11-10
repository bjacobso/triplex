# WorldVM operational primitives goal

This file is the durable work plan and progress ledger for the Triplex side of
WorldVM's operational-primitives requests. Update it as work proceeds so a new
session can resume without reconstructing earlier conversations.

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

| Order | Item                                   | Status  | PR / issue / evidence                                                                          | Dependency or blocker                  |
| ----- | -------------------------------------- | ------- | ---------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1     | TX8: schema guard and Postgres fixture | pr-open | [PR #59](https://github.com/bjacobso/triplex/pull/59), [report](test/evidence/tx8.md)          | Browser baseline failures documented   |
| 2     | TX2: public commit-position reads      | pr-open | [PR #60](https://github.com/bjacobso/triplex/pull/60), [report](test/evidence/tx2.md)          | Based on TX8 PR #59                    |
| 3     | TX1.1: contention baseline benchmark   | pr-open | [PR #61](https://github.com/bjacobso/triplex/pull/61), [report](test/evidence/tx1-baseline.md) | Based on TX2 PR #60                    |
| 4     | TX1.2: typed retryable SQL conflicts   | pending | —                                                                                              | Baseline recorded                      |
| 5     | TX1.3: late position allocation        | pending | —                                                                                              | Baseline confirms need; safety proven  |
| 6     | TX1.4: scoped concurrency, if needed   | pending | —                                                                                              | Steps 2–3 insufficient; design settled |
| 7     | TX4: inbox/outbox                      | pending | —                                                                                              | —                                      |
| 8     | TX5: cheap preconditions               | pending | —                                                                                              | —                                      |
| 9     | TX6: filtered transaction feed         | pending | —                                                                                              | —                                      |
| 10    | TX3: host-sealing/erasure RFC only     | pending | —                                                                                              | Owner decision before any code         |
| 11    | TX7: change-journal issue              | pending | —                                                                                              | Issue only                             |
| 12    | TX9: BlobStore issue                   | pending | —                                                                                              | Issue only                             |
| 13    | Direct-read pagination issue           | pending | —                                                                                              | Verify current APIs first              |
| 14    | Canonical-JSON public encoding issue   | pending | —                                                                                              | Verify existing exports first          |
| 15    | Datalog valid-time binding issue       | pending | —                                                                                              | Verify current binding support first   |

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

- Canonical ledger: this checkout, currently `bench/tx1-position-contention`. Carry the
  ledger forward on the integration tip as the PR stack grows. Initial plan commit
  is also preserved on `goal/worldvm-operational-primitives` (`c59d7d9`).
- Active item: TX1.2 typed retryable transaction conflicts is next.
- Integration tip / PR stack: `bench/tx1-position-contention`, based on TX2's
  `feat/tx2-position-reads` (`9995d96`, PR #60), based on TX8 PR #59 and main.
- Next action: create a TX1.2 branch based on the benchmark and write a failing
  conflict-classification test. Watch the pending hosted checks on PRs #60/#61.
- Decisions needed: none identified yet.
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
