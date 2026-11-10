# TX2: public commit-position reads

Date: 2026-11-10. Branch: `feat/tx2-position-reads`, based on TX8 branch
`feat/tx8-schema-guard` at `4ed65b1` ([PR #59](https://github.com/bjacobso/triplex/pull/59)).
PR: <https://github.com/bjacobso/triplex/pull/60>. Tested implementation: `735e05c`.

## Public API and adoption

Before, consumers replayed entity history and loaded transactions to recover each
fact's commit position, then manually selected assertions and retractions. Public
`TemporalBasis` offered only `recordedAt` and `validAt`.

After, pass the receipt's position directly:

```ts
const basis = { recordedPosition: receipt.position, validAt: businessInstant };
const home = yield * triples.entity(homeId, basis);
const homes = yield * triples.entities(homeIds, basis);
const matching = yield * triples.match({ entityId: homeId }, basis);
const answer = yield * triples.queryAll(query, { basis });
const page = yield * triples.queryPage({ inner: query, limit: 20 }, { basis });
```

`query`, `queryAll`, `queryPage`, and entity pages share the cut. Positions are
non-negative safe integers, zero is the empty cut, and supplying both `recordedAt`
and `recordedPosition` is rejected. Valid time is still independent; specify it to
replay the same business instant. Invalid temporal inputs follow the existing
resolver's validation behavior; page preparation reports its existing typed cursor
error. Old timestamp/default read behavior is retained.

Later retractions are hidden in both visibility and returned fact metadata for
explicit position reads. Thus the complete fact objects reproduce the earlier
read; `history` and `get` still expose the full stored audit record. Position-only
pages do not add a wall-clock constraint, so clock changes cannot alter their cut.
`EntityPageSnapshot.recordedAt` is now optional for position-only requests, a
pre-1.0 source-level change called out in the Changeset. Existing default and
timestamp pages retain that field and existing version-1 cursors remain readable.

Pagination caps a position beyond the current head at that head and binds the
captured cut to its cursor. Omit basis fields on continuation to reuse the captured
snapshot; changing a position yields `basis_mismatch`. Derivation materialization
persists, restores, and compares this shared basis rather than dropping it during
readback or journal fallback.

Run `runMigrations` from the SQL package before acquiring a host-owned unmigrated
Postgres layer: SQL migration **v4** adds the entity-position index. Standalone
migrating layers apply it automatically. Cloudflare's corresponding migration is
**v5**; KV storage needs no migration. The index is non-partial and includes
retracted historical facts. There are no outstanding design decisions for TX2.

## Adapter coverage

| Adapter       | Evidence                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| KV in memory  | Generated-history corpus, complete fact comparisons, same-millisecond regression, page cursor tests, persisted derivation basis test                               |
| Shared SQL    | Migration/DDL contract tests; existing temporal compiler predicates reused                                                                                         |
| SQLite        | Same generated corpus, v1 upgrade/idempotence, selective position query plan                                                                                       |
| Postgres      | Same generated corpus in both ordinary and sensitive-decorator suites; schema upgrades and query plan; full opt-in integration suite                               |
| Cloudflare DO | Same generated corpus in the native-SQL harness and real workerd; v1-to-v5 upgrade/idempotence                                                                     |
| FoundationDB  | Uses the same KV temporal path, but native verification unavailable: its suite skips because `/usr/local/lib/libfdb_c.dylib` is absent. No native pass is claimed. |

The generated-history property uses reproducible seeds 1, 7, 19, 42, 2026, and
65537, each with 12 random transactions over two entities. It mixes assertions,
retractions, replacements, future-effective and expired facts. At every commit it
captures the current complete fact view and query results; after subsequent writes,
every captured cut must replay identically through entity, batch, match, unbounded
and bounded Datalog, query pages, entity pages, joins, and negation. Position zero
must remain empty. This case runs through the shared adapter corpus.

## Query-plan evidence

See [the raw before/after plans](tx2-plans.json). The fixture seeds 10,000 unrelated
earlier facts and 10,000 later facts on one entity, then asks for the first ten
target facts at position 10010. Both public entity reads return those ten facts.

| Backend     | Before index                                                                   | After index                                                                                                   |
| ----------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Postgres 17 | Sequential scan: 20,000 rows examined, 19,990 discarded, 345 shared-hit blocks | Bitmap index/heap scans on `idx_entity_recorded_position`: 10 candidates, none discarded, 3 shared-hit blocks |
| SQLite      | `SEARCH triples USING INDEX idx_temporal (entity_id=?)`                        | `SEARCH triples USING INDEX idx_entity_recorded_position (entity_id=? AND recorded_position<?)`               |

These are single `EXPLAIN` observations, not throughput benchmark results. The
Postgres execution times recorded in the plans are 1.214 ms before and 0.012 ms
after in this local run; do not generalize that ratio to production.

## Commands and validation

Environment matches TX8: macOS, Node `v24.13.0`, pnpm `10.11.0`, Effect `4.1.1`,
Vitest `5.0.4`, Docker `29.4.0`, `postgres:17-alpine` via testcontainers.

Observed failing tests before their corresponding fixes:

- `pnpm --filter @triplex-build/triplex exec vitest run test/Temporal.test.ts test/Pagination.test.ts`:
  position was discarded, ambiguous/invalid inputs accepted, and pages used the head.
- `pnpm --filter @triplex-build/triplex-testkit exec vitest run test/fixtures.test.ts -t 'commit-position cuts'`:
  replay differed from the captured cut.
- `pnpm --filter @triplex-build/triplex exec vitest run test/derivation/Derivation.e2e.test.ts -t 'round-trips a materialized commit-position'`:
  dropping the saved position caused content verification to fail.
- `pnpm --filter @triplex-build/triplex exec vitest run test/Temporal.test.ts -t 'separates commits sharing'`:
  returned metadata disclosed a later retraction instead of reproducing the cut.

Query-plan commands (failed the index-selection assertion before the migration;
pass afterward):

```sh
TRIPLEX_EXPLAIN=1 pnpm --filter @triplex-build/triplex-sqlite exec vitest run test/position-index.test.ts --disableConsoleIntercept
TRIPLEX_EXPLAIN=1 pnpm --filter @triplex-build/triplex-postgres exec vitest run test/integration/postgresql.test.ts -t 'entity-position index' --disableConsoleIntercept
```

Final checks are recorded below as they finish; no unexecuted checks count as passes.

- `pnpm check`: passed, including 17 checked Markdown snippets, 745 core tests,
  SQLite and Cloudflare harness suites, real workerd conformance, package builds,
  and the documentation/link build.
- `pnpm test:postgres:integration`: 27 passed after the full-fact property and
  join/negation coverage were added.
- `pnpm pack:check`: 11 package tarballs and a clean external consumer passed,
  including public position-read call sites.
- `git diff --check`: passed.
- Focused core temporal/pagination/derivation tests: 29 passed.
- Generated-history KV case: passed after comparison was strengthened to full facts.
- `pnpm test:foundationdb:integration`: skipped its only file, no native tests run.
  `pnpm --filter @triplex-build/triplex-foundationdb exec node -e 'try { require("foundationdb"); } catch (error) { console.error(error.message); process.exitCode = 1; }'`
  confirms the missing native library.
- Browser screenshots were not rerun for TX2's non-UI changes; TX8 established
  four unchanged visual-baseline failures on both the feature branch and main.
