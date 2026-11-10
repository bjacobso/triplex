# Commit-position contention benchmark

Run from the repository root after `pnpm install --frozen-lockfile` and building
workspace packages (`pnpm exec turbo run build`). This uses built public exports,
so rebuild when comparing implementation revisions.

```sh
TX1_BENCH_OUTPUT=../evidence/tx1-baseline.json pnpm --filter triplex-stress benchmark:positions
```

With no URL, the script owns a disposable `postgres:17-alpine` testcontainer with
tmpfs data. To use your own disposable database, set `PG_BENCH_URL`. In either
case, each matrix cell creates a generated schema and drops only that schema at
scope exit. Existing schemas are not cleared. The role needs schema-create and
drop permissions and enough connections for 16 workers plus an observer/admin.
Do not pass credentials in output filenames or commit connection URLs.

The matrix is 1/4/16 disjoint writers at read committed, repeatable read, and
serializable isolation. Default: 3 repetitions, 50 commands per writer, no retries,
5 ms deliberate host work after Triplex returns, and a 5 ms observer interval.
Each worker owns one home row/entity; each command reads its host row, appends a
fact and command receipt, updates its row, inserts an outgoing host intent, waits,
then commits the host-owned outer transaction. Only Triplex's position counter is
a deliberately shared mutable row.

Pool startup, migrations, and connection warmup are excluded from timing. The
observer runs during timing, records `pg_stat_activity` waits/blocking, and checks
that each observed head has its complete distinct journal prefix. Final checks
compare committed facts, command receipts, position, host versions, and outbox
entries. Retries, if enabled, restart the whole outer transaction; all failure
attempts remain counted. SQLSTATE and failure stage are recorded separately.

Controls:

| Variable                | Default              | Meaning                                                      |
| ----------------------- | -------------------- | ------------------------------------------------------------ |
| `PG_BENCH_URL`          | unset                | Existing disposable Postgres service; otherwise start Docker |
| `PG_BENCH_IMAGE`        | `postgres:17-alpine` | Container image                                              |
| `TX1_BENCH_COMMANDS`    | 50                   | Commands per writer, 1–10,000                                |
| `TX1_BENCH_REPETITIONS` | 3                    | Matrix repetitions, 1–20                                     |
| `TX1_BENCH_HOLD_MS`     | 5                    | Host work after Triplex returns, 0–1,000 ms                  |
| `TX1_BENCH_RETRIES`     | 0                    | Retry bound per command, 0–100                               |
| `TX1_BENCH_SAMPLE_MS`   | 5                    | Observer sleep between samples, 1–1,000 ms                   |
| `TX1_BENCH_OUTPUT`      | unset                | JSON path relative to `test/stress`; otherwise stdout        |

The script writes one progress line per cell to stderr and a full JSON report at
the end. It records source revision, machine/runtime/server details, workload,
commits/sec, failures/deadlocks, retry accounting, latency percentiles, wait
samples, and visibility checks. Progress logs are not the raw report. Record
whether the source was dirty and preserve the report with the comparison.

Run an additional `TX1_BENCH_HOLD_MS=0` control to distinguish the deliberate outer
hold from ordinary transaction cost. Zero-failure results with retries do not
erase the serialization failures encountered by those retries. These measurements
are local contention evidence, not a production capacity estimate for 100,000
subjects, networked storage, different isolation/workloads, or a different host.
