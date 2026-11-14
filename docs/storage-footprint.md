# Storage footprint

What one asserted fact costs on disk in SQLite and PostgreSQL, where the bytes go, and which parts
could be smaller. Every number on this page comes from a script in the repository, so you can
measure your own shape of data:

```sh
pnpm --filter triplex-stress footprint
# Options: FOOTPRINT_TRANSACTIONS (1000), FOOTPRINT_ATTRIBUTES (8), FOOTPRINT_VALUE_BYTES (32),
# FOOTPRINT_BACKENDS (sqlite,postgresql), PG_BENCH_URL (otherwise a postgres:17-alpine container)
```

The workload commits 1,000 transactions. Each asserts one entity with eight string attributes of 32
characters, with an actor and a command ID, as a typical host write does: 8,000 asserted triples in
all. The baseline is a plain table `(entity, attribute, value)` with a primary key, holding the
same values.

## Summary

| Backend                 | Triplex, bytes per asserted triple | Plain table | Ratio |
| ----------------------- | ---------------------------------: | ----------: | ----: |
| SQLite 3 (`dbstat`)     |                                699 |          97 |    7× |
| PostgreSQL 17 (on disk) |                              1,044 |         156 |    7× |

Measured on 2026-11-13 after the journal moved to its own tables (0.5, ask 0019); 0.4 measured
2,023 bytes on SQLite and 2,428 on PostgreSQL. The sections below "Where the bytes go" describe the
0.4 layout that motivated the change; [The 0.5 layout](#the-0-5-layout) has the current split.
The first numbers on this page were measured on 2026-11-13 at the commit that added it. SQLite sizes are the pages in use after
a WAL checkpoint; PostgreSQL sizes are `pg_relation_size` plus TOAST after `VACUUM ANALYZE`.

The ratio is the price of what a plain table does not keep: every assertion's valid and recorded
times, the retracted history, an ordered journal of who changed what, and the indexes that answer
time-travel, history, journal and Datalog reads without scanning. A workload that asserts more facts
per transaction pays less journal metadata per fact; longer values raise the value share and lower
the ratio.

## The 0.5 layout

The journal no longer lives in `triples`. Each transaction writes one row to `triplex_transactions`
(its envelope and the ordered `[tripleId, op]` references to the facts it changed) and one row per
changed entity to `triplex_transaction_entities`; a transaction record is rebuilt from the
referenced facts. Same workload as above, bytes per asserted triple:

| Part                                                                                   | SQLite | PostgreSQL |
| -------------------------------------------------------------------------------------- | -----: | ---------: |
| `triples`: the facts (no journal rows)                                                 |    178 |        217 |
| Journal: `triplex_transactions` and its keys and instant index                         |     67 |         85 |
| Journal: `triplex_transaction_entities` and its key                                    |     10 |         21 |
| Journal `:_tx/change` copies and other `_Transaction` rows in `triples` (0.4: 596/653) |      0 |          0 |
| Secondary indexes on `triples` (16 on SQLite, 17 on PostgreSQL) and its primary key    |    429 |        681 |

Indexes on `triples` now hold only facts, so `idx_tx_id`, for example, fell from 115 to 44 bytes
per asserted triple on SQLite. Write time per 10-attribute transaction fell from 2.1–2.3 ms to
0.9–1.0 ms (mean, SQLite, several runs on a shared laptop): 12 rows per commit instead of 25, and the
journal's two rows enter three small indexes instead of every index on `triples`. Run the two
scripts to see your own numbers.

## Where the bytes go

Bytes per asserted triple. The `triples` table holds the facts and the journal, and is split here
in proportion to the row payloads of each kind of row.

| Part                                                                               | SQLite | PostgreSQL |
| ---------------------------------------------------------------------------------- | -----: | ---------: |
| `triples`: the facts                                                               |    181 |        213 |
| `triples`: journal `:_tx/change` copies (one per change)                           |    486 |        523 |
| `triples`: other journal facts (position, instant, actor, command, changed entity) |    110 |        130 |
| Secondary indexes on `triples` (19 on SQLite, 21 on PostgreSQL)                    |  1,210 |      1,415 |
| Primary key of `triples`                                                           |    103 |        132 |
| Command receipts table and its keys                                                |     18 |         28 |
| Everything else (snapshots, key store, migrations; nearly empty)                   |     13 |         31 |

The largest indexes, each about 50 to 175 bytes per asserted triple:

| Index                                                                       | Serves                                       | SQLite | PostgreSQL |
| --------------------------------------------------------------------------- | -------------------------------------------- | -----: | ---------: |
| `idx_temporal (entity_id, recorded_at, retracted_at, valid_from, valid_to)` | entity reads at a time                       |    133 |         62 |
| `idx_entity_attr (entity_id, attribute)`, live                              | entity and attribute reads, preconditions    |    124 |        173 |
| `idx_tx_id (tx_id)`, live                                                   | transaction reads by ID                      |    115 |         27 |
| `idx_entity_recorded_position (entity_id, recorded_position)`               | entity history at a recorded position        |     98 |         54 |
| `idx_attribute_valid_from_history`, `idx_attribute_valid_to_history`        | valid-time interval reads per attribute      | 90, 72 |   160, 160 |
| `idx_entity (entity_id)`, live                                              | entity reads                                 |     89 |         50 |
| `idx_attribute_temporal (attribute, valid_from, valid_to)`, live            | attribute reads at a valid time              |     86 |        160 |
| `idx_dependency_all (recorded_position, retracted_position, …)`             | live-query dependency state                  |     81 |         27 |
| `idx_attribute_history (attribute, recorded_position, retracted_position)`  | attribute history, and the journal page seek |     72 |        160 |
| `idx_attr_string (attribute, value_string)`, live strings                   | Datalog equality on strings                  |     72 |         94 |
| `idx_attribute (attribute)`, live                                           | attribute scans                              |     63 |         23 |
| `idx_type (entity_type)`, live                                              | entity-type reads                            |     52 |         20 |
| `idx_live_precondition_key` (PostgreSQL only)                               | cheap live preconditions                     |      — |        148 |

The full per-index list, including the small ones, is in the script's output.

## Write cost

Measured by a second script on the same machine and SQLite build:

```sh
pnpm --filter triplex-stress write-cost
# Options: WRITE_COST_TRANSACTIONS (1000), WRITE_COST_ATTRIBUTES (10), WRITE_COST_ROUNDS (5)
```

It commits 1,000 transactions of 10 string attributes each (after 50 warm-up transactions) through
`SqliteTriples.layer` on a file in WAL mode with `synchronous = NORMAL`, and times every SQLite
statement. It then replays the exact rows Triplex wrote into fresh tables with plain `node:sqlite`,
one transaction per Triplex transaction, in variants with and without the indexes and the journal,
interleaved five times and reported as medians. A CPU profile of a second live run attributes the
time spent outside SQLite. The figures below are from several runs on a shared 12-core laptop; the
ranges are the spread between runs, and replay figures come from the runs that report medians.

**Per transaction of 10 asserted triples:**

| Measure                                                          | Time                                                                                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Wall time, mean                                                  | 2.3–2.8 ms (230–285 µs per triple)                                                                                                     |
| Wall time, median                                                | 1.5–1.8 ms                                                                                                                             |
| Inside SQLite statements                                         | 85% (1.9–2.3 ms)                                                                                                                       |
| JavaScript outside SQLite (Effect runtime, encoding, validation) | 15% (0.34–0.49 ms)                                                                                                                     |
| SQL statements                                                   | 22 (16 `INSERT INTO triples` statements for 25 rows, plus `BEGIN`, a savepoint, the commit position, the command receipt and `COMMIT`) |

Most of the SQLite time is reported under `COMMIT` (1.6–2.4 ms), because that is when the pages
dirtied by the inserts, mostly index pages, are written to the WAL. The CPU profile agrees: 78–82% of
self time is in SQLite's native statements, 11–14% in the Effect runtime, and 2–4% in Triplex's own
code, which includes validation and encoding. Statement count and validation are therefore not where
the time goes.

**What the rows cost** (replay, µs per transaction):

| Rows inserted                     | Table and primary key only | With all 19 indexes |
| --------------------------------- | -------------------------: | ------------------: |
| The 10 facts only                 |                     80–141 |             743–976 |
| The facts and the 15 journal rows |                    163–196 |         1,716–2,185 |

Each transaction writes 25 rows: the 10 facts and 15 journal rows (10 `:_tx/change` copies and five
metadata facts). Every row is maintained by every index on `triples` whose predicate it meets, which
is why index maintenance is about 90% of the replay time, and why the journal, at 60% of the rows,
costs about as much as the facts.

**What each candidate would save** (replay, against keeping everything):

| Change                                                                                 | Write time saved |
| -------------------------------------------------------------------------------------- | ---------------: |
| Drop `idx_entity`, `idx_attribute`, `idx_recorded_position` (v13 dropped the last two) |           10–18% |
| Remove the journal's change copies entirely (an upper bound for slimming them)         |              21% |
| Keep journal rows only in the six indexes journal reads use                            |           32–37% |
| Move journal rows to their own table with three indexes                                |           36–40% |
| Drop the three indexes and move the journal rows                                       |           40–50% |

The change copies cost write time through their index entries, not their bytes: slimming each copy
to a reference would save most of their 486 bytes per triple but keep one indexed row per change. So
the larger write-time lever is which indexes journal rows enter, not how big they are.

A consumer that moves from one JSON value per fact to one triple per attribute multiplies its rows by
the number of attributes, and each new row brings a journal copy and its index entries; that is the
shape of the 26% slowdown reported against 0.3.0.

## What could be smaller

The numbers above were measured before SQL migration v13. Migration v13 dropped items 3 and 4
below, which brought the totals to 2,023 bytes per asserted triple on SQLite and 2,424 on PostgreSQL.
The other items look avoidable but are not done; each needs its own change, checked with the plan
fixtures (`test/fixtures/*-index.ts`) and the plan diff
(`pnpm --filter triplex-stress index-plan-diff`) before and after.

1. **Journal change copies (about 490 to 520 bytes per triple, the largest single part; up to 21%
   of write time).** See the [design note](rfcs/journal-change-references.md). Each
   `:_tx/change` fact repeats the changed fact's ID, entity, attribute, value, valid and recorded
   times and transaction IDs as JSON. All of it except the operation and its order is already on the
   fact row, which is immutable apart from its retraction fields. A journal entry could keep only
   `(tripleId, op, changeIndex)` and read the rest from the fact. Cost: a transaction read becomes a
   join on the primary key, and the journal is no longer self-contained, so a fact must never be
   deleted while its journal entry exists. Saving: most of the 490 to 520 bytes, about a fifth of the
   total.
2. **`idx_entity` (89 / 50 bytes): kept.** It is the leading column of `idx_entity_attr` with the
   same predicate, but the plan diff shows that without it SQLite moves 14 entity reads to
   `idx_entity_recorded_position`, which also holds retracted rows, so entities with long histories
   would read more.
3. **`idx_attribute` (63 / 23 bytes): dropped in migration v13.** No SQLite plan used it.
   PostgreSQL used it occasionally, and `idx_attribute_history` and `idx_attribute_temporal` share its
   leading column.
4. **`idx_recorded_position` (33 / 25 bytes): dropped in migration v13.** It is a prefix of
   `idx_dependency_all`, which takes over its two SQLite plans and its PostgreSQL scans.
5. **`idx_temporal` and `idx_entity_recorded_position` (231 / 116 bytes together).** Both serve
   entity history, one by time and one by position. Reads by recorded time already resolve to a
   position, so one index may be enough. Cost: changing the entity history read path, so it needs a
   design check, not just a plan check.

Items 1 to 4 together were about 670 bytes per triple on SQLite (about 30% of the total) and 620 on
PostgreSQL (about 25%); items 3 and 4, now dropped, were 96 and 48. The remaining indexes each serve a read the plan fixtures pin, and the facts,
the journal metadata and the primary key are the history itself.

## Notes

- Sensitive values add the sealed envelope and, for equality, a blind token and its partial index
  (`idx_attr_blind`); see [Sensitive values](/sensitive-values#storage). This workload has none.
- Entity snapshots (`entity_snapshots`, `entity_blobs`) are empty unless a host materializes them.
- SQLite reuses free pages but does not shrink the file on its own; run `VACUUM` to return space
  after large deletions. PostgreSQL relies on autovacuum.
