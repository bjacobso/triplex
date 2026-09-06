# Datalog pagination and performance

`Triples.query` and `Triples.queryPage` return at most 100 bindings by default. Page sizes are
validated in the shared service boundary and may not exceed 1,000. SQL fetches one extra row to
determine whether `nextCursor` exists; only the requested page reaches the caller. Total counts
are opt-in. `queryAll` is the explicit complete-result API for trusted batch processing.

## Measurements

Measured on September 6, 2026 in the development Linux VM using Node 24.14.1, SQLite 3.51.2
(in memory), and local PostgreSQL 16.14. The synthetic fixture contains 10,000 entities and
30,000 facts: a name, numeric score, and group per entity. It has no retracted facts or journal
traffic. Both databases were analyzed after seeding. Each measurement is the median wall time
of five warm executions; seeding, warm-up, and EXPLAIN are excluded. These are local diagnostic
measurements, not production latency guarantees or a backend ranking.

| Query                                         | Backend    | Complete result | First 100 | Page 6 (100) | First 100 + count |
| --------------------------------------------- | ---------- | --------------: | --------: | -----------: | ----------------: |
| All facts (30,000 rows)                       | SQLite     |        99.76 ms |  35.30 ms |     43.33 ms |          63.89 ms |
| All facts (30,000 rows)                       | PostgreSQL |        68.32 ms |  56.67 ms |     50.78 ms |          76.59 ms |
| Fixed attribute (10,000 rows)                 | SQLite     |        22.49 ms |  12.73 ms |     15.68 ms |          23.17 ms |
| Fixed attribute (10,000 rows)                 | PostgreSQL |        20.93 ms |  16.30 ms |     16.65 ms |          29.43 ms |
| Name/score join with score >= 50 (5,000 rows) | SQLite     |        23.02 ms |  16.00 ms |     15.75 ms |          28.85 ms |
| Name/score join with score >= 50 (5,000 rows) | PostgreSQL |        43.00 ms |  18.33 ms |     18.15 ms |          28.68 ms |
| Grouped distinct count (250 rows)             | SQLite     |        14.38 ms |  15.19 ms |            — |          29.65 ms |
| Grouped distinct count (250 rows)             | PostgreSQL |        27.22 ms |  28.76 ms |            — |          56.48 ms |

The complete-result column uses `queryAll` at the latest recorded state. Paged reads additionally
pin a recorded timestamp and commit position, so this compares the public operations rather than
isolating SQL LIMIT alone. No offset is used to advance pages. Page 6 is reached by following
five cursors; only the continuation request is timed.

## What the execution plans show

Both SQL backends receive LIMIT 101 for a 100-row page. They do not send the full matching
relation to JavaScript. However, generic pagination does **not** bound the amount of database
work needed to produce that page:

- SQLite uses temporary B-trees for projection distinctness and outer ordering. Fixed-attribute
  snapshot queries use `idx_attribute_history`; snapshot joins also use the entity temporal index.
- PostgreSQL's all-facts first page scans 30,000 rows, deduplicates 30,000 projected rows, then
  applies a top-N sort and LIMIT. The fixed-attribute case uses `idx_attribute_history` to read
  10,000 candidates. The join reads its matching attributes and uses a hash join.
- Grouped queries still process all contributing facts before returning a page of groups.
  Recursive queries may likewise compute a large closure before applying the result limit.
- `includeCount` executes a second query over the complete filtered relation. It excludes the
  cursor boundary so the count remains the total size of the snapshot, even on later pages.

The wrapper compiler removes inner ordering when there is no inner limit or offset, avoiding
an unnecessary sort. Inner limits and offsets retain their ordering and receive deterministic
projected-row tie-breakers. Recursive wrappers use the recursive compiler. Debug output reports
actual compiler metrics and includes count execution time in `executionTimeMs`, with
`countExecutionTimeMs` available separately. `debug.generatedSql`, `debug.params`, and
`debug.queryPlan` describe the actual page, including the snapshot and continuation boundary;
`explain` describes the logical Datalog query without capturing a read snapshot.

For large catalogs, select fixed attributes and restrictive patterns, project only needed
bindings, and request counts only where they are useful. An index on a public sort value alone
cannot eliminate arbitrary joins, aggregation, mixed-type canonicalization, or distinctness.
Further index/compiler changes should be evaluated against representative history density,
attribute fan-out, recursive graphs, and deep cursors. The KV executor still materializes
intermediate bindings before sorting and slicing; bounded output is not bounded executor memory.

## Read-path audit

The Datalog bounds apply to raw query execution in the CLI and dashboard as well as to the core
service. The dashboard's All facts preset no longer embeds a total limit of 100, so its Next
page control can traverse the entire snapshot. CLI continuation uses `query run --cursor` or
`query page` with a wrapped request.

Low-level `match`, `entity`, `entities`, and `history` are complete materialization APIs. The
existing dashboard overview and reflected entity browser, CLI fact matching/entity listing,
and journal implementation still contain complete fact reads. Their array slicing is not
storage-level pagination. They need separate fact/entity/journal paging contracts before the
application can claim that **every** read avoids loading a catalog. This change establishes the
bounded Datalog contract; it does not make that broader claim.

## Reproduce

The benchmark lives in `test/stress/scripts/datalog-pagination.ts` and is opt-in:

```sh
pnpm exec turbo run build --filter=@bjacobso/triplex-sqlite --filter=@bjacobso/triplex-postgres
pnpm --filter triplex-stress benchmark:datalog
PG_BENCH_URL=postgresql://localhost/triplex_bench pnpm --filter triplex-stress benchmark:datalog
```

Use an empty, disposable PostgreSQL database. The script refuses a nonempty facts table and
leaves its seeded facts behind for inspection. `DATALOG_BENCH_ENTITIES` changes the fixture size.
JSON output includes every timing, generated statement, SQLite EXPLAIN QUERY PLAN, and PostgreSQL
EXPLAIN ANALYZE with buffer statistics. Backend suites can also use an explicitly supplied
`PG_TEST_URL` pointing to a disposable database when Docker is unavailable:

```sh
PG_TEST_URL=postgresql://localhost/triplex_test pnpm test:postgres:integration
```
