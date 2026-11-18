---
"@triplex-build/triplex": minor
---

**Bounded history pages, and an index that makes optional projections fast on SQL.**

`Triples.historyPage(entityId, { attribute?, limit?, cursor?, recordedPosition? })` returns one page
of an entity's history, or of one attribute's history, oldest first by commit position and then fact
ID, including retracted assertions. The first page captures a commit position (the head, or
`recordedPosition`) and every continuation reads at that position, so writes between pages neither
repeat nor skip facts: a later assertion is not shown, and a fact retracted after the snapshot is shown
unretracted, as it was then. Pages default to 100 facts (maximum 1,000) and are read by an index seek,
so a page costs the same for an entity with 10 facts as for one with 10,000. The cursor is opaque and
bound to its database scope, entity, attribute and position; reusing it elsewhere fails with
`PaginationCursorError`. Sealed values stay sealed. The host protocol has a matching `HistoryPage`
operation. `history(entityId)` is unchanged.

SQL migration 2 (`triplex_entity_attribute_history_index`) and Cloudflare migration 8 add
`idx_entity_attribute_history ON triples(entity_id, attribute, recorded_position)`. Besides serving
per-attribute history pages, it lets a Datalog `optionalProjection` look up each row's value directly;
before, SQLite planned those per-row lookups on an attribute-wide index. On the explorer's
1,200-worker demo database, a 50-row page sorted by an optional attribute drops from 6.2–8.7 s to
38–56 ms.

`runMigrations` and the migrating layers upgrade a 0.5.0 database in place. The non-migrating and
read-only layers refuse it with `SchemaVersionError` (`pending: true`) until migrations run. In-memory
and FoundationDB KV stores backfill the new history keys once, in bounded batches, on the first history
page.
