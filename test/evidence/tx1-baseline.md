# TX1.1: Postgres commit-position contention baseline

Date: 2026-11-10. Benchmark-only PR; no allocator or public API change.
Base: TX2 [PR #60](https://github.com/bjacobso/triplex/pull/60).

## Finding

The concern is confirmed on the tested workload. Disjoint entities and host rows
still contend on `triplex_commit_position`. Read committed completes the commands
but queues at the allocator. Repeatable read and serializable fail with SQLSTATE
40001 **at position allocation**, even with no deliberate post-allocation hold.
No deadlocks were observed. Error wrappers currently require inspecting their
causes to identify that SQLSTATE; TX1.2 remains justified.

These are local measurements of one database and workload, not a capacity estimate
for WorldVM's 100,000-subject target. The 5 ms hold deliberately models host work
between the nested Triplex call and the outer commit; it is not a claim about the
actual duration of a WorldVM command. The zero-hold control separates it from the
baseline transaction cost.

## Reproduction

Measured source: [`32a3360`](https://github.com/bjacobso/triplex/commit/32a3360b6e03c3d13b8159f1fd08e9b695fca575),
preserved on `bench/tx1-baseline-source`. Both reports record that revision and
`trackedSourceDirty: false`. The PR branch rebases this same harness on TX2's
subsequent report-only syntax correction; the measured implementation is unchanged.

Environment: Apple M2 Max, arm64 macOS, 12 host CPU cores, 32 GiB host RAM;
Node v24.13.0; pnpm 10.11.0; Effect/@effect/sql-pg 4.1.1; Docker server 29.4.0;
Postgres **17.8**, from `postgres:17-alpine` in a testcontainer using tmpfs storage
under Docker Desktop. Container CPU/memory allocation is not recorded, so host
resources are not a claim about resources available inside its VM.

Build public package exports before benchmarking:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build
TX1_BENCH_OUTPUT=../evidence/tx1-baseline.json pnpm --filter triplex-stress benchmark:positions
TX1_BENCH_HOLD_MS=0 TX1_BENCH_OUTPUT=../evidence/tx1-zero-hold.json pnpm --filter triplex-stress benchmark:positions
```

The existing TX2 root check built the packages before these runs. No compilation,
test suites, or second benchmark ran concurrently with either measurement. A smoke
matrix with `TX1_BENCH_COMMANDS=3 TX1_BENCH_REPETITIONS=1` exercised the harness
before the measured runs. See the [harness instructions](../stress/scripts/commit-position-contention.md)
for parameters and implementation details.

Workload: 1/4/16 writers, three isolation levels, 50 commands per writer, three
repetitions, **zero retries**, and a 5 ms observer sleep. Configurations rotate
across rounds. Each matrix cell owns an isolated migrated schema. Every worker
owns a distinct entity and host home row. Each command reads its row, writes a
Triplex assertion plus command receipt, updates the host version, appends an intent
to a host outbox, optionally waits 5 ms, and commits the host-owned transaction.
Pool setup/warmup and migrations are excluded from timing. Observer overhead is
included and may affect these local numbers.

## Results

Commit rates are the **median of three runs**. Attempt/commit/failure counts are
the **sum across all three runs** for that configuration. Raw reports retain every
run, latency percentile, error location, wait sample, and environment field:

- [5 ms outer hold](tx1-baseline.json)
- [zero-hold control](tx1-zero-hold.json)

| Isolation       | Writers | Attempts | Commits | 40001 failures, 5 ms | Deadlocks | Commits/s, 5 ms | Commits/s, zero hold |
| --------------- | ------- | -------- | ------- | -------------------- | --------- | --------------- | -------------------- |
| Read committed  | 1       | 150      | 150     | 0                    | 0         | 85.5            | 328.1                |
| Read committed  | 4       | 600      | 600     | 0                    | 0         | 94.8            | 508.8                |
| Read committed  | 16      | 2400     | 2400    | 0                    | 0         | 97.0            | 513.2                |
| Repeatable read | 1       | 150      | 150     | 0                    | 0         | 89.6            | 366.5                |
| Repeatable read | 4       | 600      | 150     | 450                  | 0         | 84.9            | 272.6                |
| Repeatable read | 16      | 2400     | 150     | 2250                 | 0         | 80.4            | 143.4                |
| Serializable    | 1       | 150      | 150     | 0                    | 0         | 97.6            | 361.9                |
| Serializable    | 4       | 600      | 150     | 450                  | 0         | 84.3            | 272.9                |
| Serializable    | 16      | 2400     | 150     | 2250                 | 0         | 78.7            | 146.7                |

Zero-hold attempt, commit, serialization, and deadlock counts were identical to
the 5 ms counts in every configuration. At 16 writers, **93.75%** of attempts at
either higher isolation level failed at allocation in both workloads. With read
committed, increasing concurrency from four to sixteen barely improved throughput.
The larger throughput reduction with the 5 ms hold is consistent with the
allocator lock remaining part of the host transaction's commit boundary.

Where waiting happens, from sampled `pg_stat_activity` and `pg_blocking_pids`:

- Baseline: **56,094 sampled session lock waits** executing a statement mentioning
  `triplex_commit_position`, versus 19 other sampled session lock waits.
- Zero hold: **13,780 allocation lock samples**, versus 5 other lock samples.
- Wait events include `Lock:transactionid` and `Lock:tuple`; up to **15 sessions**
  were blocked at once in 16-writer configurations.
- Every serialization failure in both reports is classified as
  `40001:position-allocation`. No failures were observed at host-row reads/writes
  or the outer commit. Sampling counts are observations, not distinct waits or
  cumulative milliseconds, and can miss short waits.

The source allocates via an upsert inside the host's ambient transaction, so
moving the nested Triplex return earlier cannot release that row lock. The smoke
and full runs demonstrate contention at that exact statement. The zero-hold
results also show that eliminating deliberate host work alone does not eliminate
snapshot-isolation serialization failures.

## Ordering, adapter scope, and next steps

No allocation or ordering semantics changed. The observer performed **6,732**
single-statement snapshot checks in the baseline and **2,006** in the control:
observed heads never decreased and matched both the distinct journal-position
count and maximum. Final facts, command receipts, host versions, outbox count,
and position equaled successful commits in every cell. No visibility hole or
partial commit was observed. These checks supplement the existing ordering/replay
tests; they do not prove correctness for all interleavings.

This benchmark covers Postgres only because the claim concerns its MVCC behavior,
SQLSTATEs, and singleton-row allocation. Shared SQL, SQLite, Cloudflare, KV, and
FoundationDB contracts and implementations are unchanged. Public API before/after:
not applicable. Adoption/migration: none; this adds an opt-in private stress command.
An empty Changeset records the tooling change without versioning private packages.

Proceed to TX1.2 in a separate PR. For TX1.3, distinguish shortened lock duration
from snapshot staleness: the higher-isolation failures persist with zero hold, and
graph constraints currently depend on the global serialized boundary. Any late
allocation or scoped-concurrency design must preserve cross-entity constraints
and the invariant that a snapshot reader cannot see N+1 without committed N.
Do not replace the counter with an ordinary sequence and accept visibility holes.

Validation: `pnpm --filter triplex-stress typecheck`, `pnpm check`,
`pnpm pack:check` (11 tarballs and clean consumer), and `git diff --check` pass.
Both complete benchmark runs and all their invariant checks succeeded. The PR
link is recorded in `GOAL.md` when opened. The benchmark does not change production
interfaces, so existing adapter integration behavior remains as verified in TX2.
