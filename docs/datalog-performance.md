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
pnpm exec turbo run build --filter=@triplex-build/triplex-sqlite --filter=@triplex-build/triplex-postgres
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

## Numeric ranges and actor due-work

Triplex provisions `idx_attr_numeric` on `(attribute, COALESCE(value_number, value_datetime))`
for facts whose `value_type` is `number` or `datetime`. It matches the compiler's existing scalar
expression: both storage types compare numerically, and equal numeric values still collapse in
Datalog projections. The existing number-only index remains available for typed storage reads.

This covers the actor due-work query in Runfold, the engine that runs [WorldVM](/worldvm) programs,
without an application index declaration or per-actor DDL:

```ts check
import { Effect } from "effect";
import { Triples } from "@triplex-build/triplex";

const dueRows = (attribute: string, marker: string, now: number) =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    return yield* triples.query(
      {
        find: ["?item", "?actor", "?due"],
        where: [
          ["?item", attribute, "?due"],
          ["<=", "?due", now],
          ["?item", marker, "?actor"],
        ],
        orderBy: [{ variable: "?due", direction: "asc" }],
        limit: 128,
      },
      { pageSize: 128 },
    );
  });
```

`limit` is the logical result bound; `pageSize` controls the public page. Without the explicit
`pageSize`, current Triplex returns up to 100 rows and a continuation even with `limit: 128`.

Unlike Runfold's `runfold_actor_due` workaround, this index includes retracted numeric facts.
`Triples.query` pins a recorded position and time, and can see facts retracted after that snapshot.
A partial index restricted to `retracted_at IS NULL` cannot serve those reads. Valid-time and
recorded-time predicates remain residual filters; the index does not change visibility.

The regression fixture has 10,000 pending items: 160 due, 9,840 future, alternating numeric and
datetime storage, plus 80 retracted numeric facts and 10,000 pending markers. After `ANALYZE`,
SQLite and PostgreSQL select the expression index with **both attribute equality and a numeric
range bound**, for live reads and the actual SQL emitted by `Triples.query`. PostgreSQL's bitmap
index scan visits 240 numeric candidates (160 live plus 80 historical), excluding the 9,840 future
values. Removing the new index restores an attribute/temporal scan: PostgreSQL's snapshot
query reads 10,080 due-attribute candidates and filters out 9,920 of them. SQLite likewise switches
from the expression range to `idx_attribute_history` for snapshot pages. The regression tests
assert a numeric range in the index condition, not merely that an index exists.

These are local plan observations, not a promise of a particular plan on every dataset.
The PostgreSQL planner may still scan pending markers for its join. Both backends still sort and
deduplicate; a 128-row limit does not guarantee only 128 facts are examined. Dense due queues and
large numeric histories need their own measurements. KV retains equivalent results using its
existing executor and does not gain a SQL-style range-plan optimization.

To inspect the plans, run these tests with `TRIPLEX_EXPLAIN=1` (add `--disableConsoleIntercept`
if the test reporter suppresses output):

```sh
TRIPLEX_EXPLAIN=1 pnpm --filter @triplex-build/triplex-sqlite exec vitest run test/numeric-index.test.ts
PG_TEST_URL=postgresql://localhost/disposable_test TRIPLEX_EXPLAIN=1 pnpm --filter @triplex-build/triplex-postgres exec vitest run test/integration/postgresql.test.ts -t 'expression range' --disableConsoleIntercept
```

### Scope of consumer indexing

This change takes the core-index route rather than adding a new portable declaration API: the
concrete due-work requirement is shared by numeric Datalog queries across attributes. Consumers
express the query through the same backend-portable `Triples` API and provision its index once
through the [migration API](/host-integration#host-controlled-migrations).

Triplex does **not** yet expose arbitrary consumer index declarations. Workloads needing narrower
attribute-specific indexes, compound application projections, custom uniqueness, or text search
still need a separate design. Host-owned SQL DDL remains a backend-specific escape hatch at
provisioning/migration time; it is not a portable indexing contract. A future declaration API
must define backend capabilities, unsupported requirements, naming, changes/removal, and migration
ownership, including KV behavior. Do not create indexes per actor, request, or query.
