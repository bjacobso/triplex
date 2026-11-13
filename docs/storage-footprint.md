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
| SQLite 3 (`dbstat`)     |                              2,121 |          97 |   22× |
| PostgreSQL 17 (on disk) |                              2,472 |         156 |   16× |

Measured on 2026-11-13 at the commit that added this page. SQLite sizes are the pages in use after
a WAL checkpoint; PostgreSQL sizes are `pg_relation_size` plus TOAST after `VACUUM ANALYZE`.

The ratio is the price of what a plain table does not keep: every assertion's valid and recorded
times, the retracted history, an ordered journal of who changed what, and the indexes that answer
time-travel, history, journal and Datalog reads without scanning. A workload that asserts more facts
per transaction pays less journal metadata per fact; longer values raise the value share and lower
the ratio.

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

## What could be smaller

Nothing on this page has been dropped. These are the parts that look avoidable, with what dropping
each would cost. Each needs its own change, with the index-plan fixtures (`test/fixtures/*-index.ts`)
run before and after.

1. **Journal change copies (about 490 to 520 bytes per triple, the largest single part).** Each
   `:_tx/change` fact repeats the changed fact's ID, entity, attribute, value, valid and recorded
   times and transaction IDs as JSON. All of it except the operation and its order is already on the
   fact row, which is immutable apart from its retraction fields. A journal entry could keep only
   `(tripleId, op, changeIndex)` and read the rest from the fact. Cost: a transaction read becomes a
   join on the primary key, and the journal is no longer self-contained, so a fact must never be
   deleted while its journal entry exists. Saving: most of the 490 to 520 bytes, about a fifth of the
   total.
2. **`idx_entity` (89 / 50 bytes).** It has the same predicate as `idx_entity_attr` and is its
   leading column, so the larger index can serve the same lookups. Likely avoidable with no plan
   change; confirm with the plan fixtures.
3. **`idx_attribute` (63 / 23 bytes).** It is the leading column of `idx_attribute_temporal` with the
   same predicate. Likely avoidable the same way.
4. **`idx_recorded_position` (33 / 25 bytes).** It is a prefix of `idx_dependency_all`. Likely
   avoidable the same way.
5. **`idx_temporal` and `idx_entity_recorded_position` (231 / 116 bytes together).** Both serve
   entity history, one by time and one by position. Reads by recorded time already resolve to a
   position, so one index may be enough. Cost: changing the entity history read path, so it needs a
   design check, not just a plan check.

Items 1 to 4 together are about 670 bytes per triple on SQLite (about 30% of the total) and 620 on
PostgreSQL (about 25%). The remaining indexes each serve a read the plan fixtures pin, and the facts,
the journal metadata and the primary key are the history itself.

## Notes

- Sensitive values add the sealed envelope and, for equality, a blind token and its partial index
  (`idx_attr_blind`); see [Sensitive values](/sensitive-values#storage). This workload has none.
- Entity snapshots (`entity_snapshots`, `entity_blobs`) are empty unless a host materializes them.
- SQLite reuses free pages but does not shrink the file on its own; run `VACUUM` to return space
  after large deletions. PostgreSQL relies on autovacuum.
