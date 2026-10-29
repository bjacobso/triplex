---
description: Immutable import segments, attached in one transaction and published through a ref, for loading large datasets into the in-memory store.
---

# Import segments

Loading a large dataset through `Triples.transact` writes every fact five times (one key per index
plus a META record) and, by default, journals every fact again. That is the right default for
application writes, and the wrong shape for loading 160,000 facts into a browser tab. Import
segments borrow git's answer to "write a lot of data, then publish it atomically": keep the
writes cheap, do the expensive work in bulk once, and publish by moving a ref.

Segments are an experimental prototype. Only the in-memory KV backend can attach one today; the
SQL backends fail with `WriteError`. The design below says how the other backends would store one.

```ts
import { Effect } from "effect";
import { Triples } from "@triplex-build/triplex";
import { Import, PositionRef, Segment } from "@triplex-build/triplex/operational";

const load = (facts: Iterable<TripleInput>) =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    // Build each chunk into a segment, attach it in one transaction, yield to the host, and
    // finally move the ref in one more transaction.
    yield* Import.run(triples, facts, { store: "segments", chunkSize: 4_000, ref: "account/live" });
    // Readers resolve the ref once and read at that cut.
    const basis = yield* PositionRef.basis(triples, "account/live", { validAt: Date.now() });
    return yield* triples.match({ attribute: ":worker/name" }, basis);
  });

// Or ship a prebuilt dataset: build and encode it ahead of time, then attach the bytes.
const image = Segment.encode(Segment.build(facts));
const attachImage = (bytes: Uint8Array) =>
  Effect.flatMap(Triples, (triples) => Segment.attach(triples, Segment.decode(bytes)));
```

## The mapping

| Git                      | Triplex                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| Loose objects            | `transact`: per fact, per index, per journal entry.                                                |
| Packfile and `.idx`      | A `Segment`: facts sorted and indexed in one pass, immutable, content-addressed.                   |
| Commit                   | `Segment.attach`: one transaction recording the segment ID, fact count and position.               |
| Ref and compare-and-swap | `PositionRef`: a named commit position, moved in one transaction with an expected-old-value check. |
| `clone` from a pack      | `Segment.decode` then `attach`: the columns are views over the bytes, so nothing is re-sorted.     |
| `git gc` / repack        | Not built. See [Repacking](#repacking).                                                            |

## Segment format

`Segment.build(facts)` is a pure function of its input, so it can run in a worker. Its result is
plain data (typed arrays, arrays and one map) that survives `postMessage`, and `Segment.encode`
turns it into one transferable buffer.

- **Dictionary.** Every entity ID, attribute, entity type, `createdBy`, string and ref value, blob
  hash and canonical JSON value goes into one sorted, de-duplicated string array. Because it is
  sorted, comparing dictionary indexes compares strings.
- **Columns**, one entry per fact, in canonical order: entity, attribute, value kind, numeric value
  (number, datetime, boolean), dictionary value (string, ref, blob hash, JSON), `validFrom`,
  `validTo`, entity type and `createdBy`. Absent fields are `NaN` or `-1`. Valid time is data:
  each fact keeps its own interval.
- **Canonical order** is entity, attribute, value, then the remaining fields, which makes the
  entity index (EAVT) the identity permutation.
- **Permutation indexes** for the other access paths: by attribute (AEVT), by attribute and value
  (AVET), ref values by target (VAET), and by entity type. Each is a `Uint32Array` of ordinals.
- **Binary image**: a small header, the dictionary as JSON, then each column 8-byte aligned.
  `decode` views the columns in place and doesn't copy or re-sort them.

A segment says nothing about recorded time. Attaching it supplies that.

### Content identity

A segment's `id` is `ContentId.hash("triplex/segment", content)`, where `content` is the
`CanonicalJson` encoding of `[entity, attribute, value, validFrom, validTo, entityType,
createdBy]` for every fact, in canonical order, with `null` for absent fields. The same facts in
any input order produce the same ID. `Segment.verify(segment)` recomputes it from the columns, and
`decode(bytes, { verify: true })` rejects an image whose content doesn't match its ID. So "this
account was loaded from segment sha256-…" can be checked by rebuilding the segment from the source
data, or by verifying the shipped image.

## Attaching

`Segment.attach(triples, segment, meta)` runs one ordinary `transact` with no operations:

1. It allocates a commit position and claims the command ID, if there is one.
2. It stores the segment body in the backend's segment store. A body is content-addressed and inert
   until an attachment names it, so storing it outside the transaction is safe, like writing a git
   object before the commit that references it.
3. It writes one attachment record, keyed by position, naming the segment, transaction ID, instant
   and actor.
4. It journals one `_Transaction` envelope.

Every fact in the segment then has the attachment's recorded position, instant and transaction ID.
`createdBy` defaults to the attaching actor. A fact's triple ID encodes where it lives: `U`, the
attachment position in 12 base-32 digits, then the ordinal in 13. ULIDs never contain `U`, so these
IDs can't collide with generated ones. `Triples.get` resolves them directly.

An attachment carries no other operations, and doesn't support constraint enforcement. Reserved
entities, attributes and entity types are checked the same way as in `transact`.

## Reads: merge on read

Every read path (`match`, `entity`, `entities`, `entityPage`, `history`, temporal scans,
`dependencyState` and Datalog) appends the facts of attached segments to the indexed facts:

1. For each attachment, binary-search the segment's narrowest index for the pattern.
2. With a basis, skip attachments recorded after it, and skip facts not valid at `validAt` straight
   from the columns, before building any objects.
3. Decode the surviving facts.
4. Apply the same pattern and visibility checks as indexed facts.

The cost is O(attachments × log n) to locate the ranges, plus the matching facts. There is no
per-fact index lookup and no META decode. At 160,000 facts, reading every attribute at one `validAt`
takes 0.15 s from segments, against 1.4–1.7 s through the KV indexes.

Order across indexed and segment facts is unspecified, as it already was for `match`.

### Retraction

Segments are immutable, so retracting a segment fact works like any other KV retraction: the
retracting transaction writes the fact's datom, with its retraction, to META. On read, META
records override the segment copy, found with one range scan per attachment (the retraction
records share the attachment's ID prefix). The retraction is ordinary history: `history` shows
it, reads before its position still see the fact, and the retracting transaction's journal entry
lists it as a `retract` change.

## History and the journal

An attachment journals one envelope: position, instant, actor, command, correlation and causation,
plus a `:_tx/summary` with:

- `asserted`: the segment's fact count, and `retracted: 0`;
- `attributes`: the segment's distinct attributes;
- `digest` and `segments`: the segment ID.

It writes no `:_tx/change` and no `:_tx/changed-entity` per fact or entity. Each read derives
what it needs from the segment instead:

| Read                            | What a segment attachment returns                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `transactions()`                | One record with the summary and an empty `changes` list. Paging the feed stays cheap.            |
| `transaction(txId)`             | The same record, with every fact as an `assert` change, derived from the segment on demand.      |
| `transactionsForEntity(entity)` | The attachments whose segment contains the entity, merged by position with indexed transactions. |
| `transactionByCommand`          | As for any transaction.                                                                          |
| `history(entity)`               | Every segment fact for the entity, and any retractions of them.                                  |

Compared with loading the same facts through `transact`, audit keeps:

- who loaded them, when (instant and position), and under which command and correlation;
- every fact, with its recorded and valid time, as ordinary queryable history;
- per-fact change records (derived on request) and the entity-to-transaction index;
- a content identity that names exactly which facts were loaded.

What changes or is lost:

- The journal no longer duplicates the facts, so the journal alone can't rebuild them: the segment
  body must survive.
- Losing the body makes the attachment unreadable, and reads fail loudly rather than silently
  missing facts.
- Datalog over `:_tx/change` or `:_tx/changed-entity` doesn't see attached facts. Use
  `transaction` or `transactionsForEntity`.
- Subscribers to the journal (derivation freshness, change emission, entity snapshots) handle the
  summary as for `journal: "summary"`. Derivation relevance uses its attributes, and emission and
  snapshots read the derived changes.

## Refs and incremental imports

`Import.run(triples, facts, { store: "segments", ref })` builds and attaches one segment per chunk,
yields to the host's event loop between chunks, then moves the ref in one final transaction with
the import manifest (counts, position range, and a digest over the segment IDs).

- **Readers at the ref** resolve it once with `PositionRef.basis` and read at `{ recordedPosition }`.
  Every chunk's position is after the old ref, so they see the previous publication until the move
  and the whole import after it.
- **Readers at the previous ref position** see exactly what they saw before.
- **The move** is compare-and-swap safe: give `expectedRefPosition`, and a concurrent move fails
  with `PositionRefConflictError` instead of being overwritten.
- **Readers at the latest state** see chunks as they attach. A failed import leaves its attached
  chunks unpublished.

A ref is resolved per read basis, not per query. A `{ ref }` field that each read resolved
separately could straddle a move between two reads, which is the torn read refs exist to prevent.

## Other backends

The design needs three things from a backend: somewhere to keep immutable bodies by ID, an
attachment record written in the attaching transaction, and reads that merge the two.

- **Ordered KV (FoundationDB).** Store the encoded body in chunks under its own key prefix,
  `segment ID + chunk number`, within the value size limit. Body writes can happen before the
  attaching transaction, since nothing reads an unattached body. The attachment record and
  retraction overlays are already plain KV keys. Readers would load and cache decoded bodies, so
  merge-on-read works unchanged. Another option is to expand a body into the ordinary indexes in
  background transactions while it stays readable as a segment ("repacking into loose objects").
- **SQL (SQLite, PostgreSQL, Cloudflare).**
  - Keep `segments(id, bytes)` and `segment_attachments(position, segment_id, tx_id, instant,
actor)` tables.
  - Merge-on-read in SQL is awkward, so the practical route is to expand the segment into
    `triples` rows inside the attaching transaction with one bulk insert (`COPY` on PostgreSQL),
    while keeping the attach-shaped journal.
  - The win there is the journal and the bulk insert, not memory.

## Repacking

Not built. Many small segments cost one binary search each per read, which stays cheap up to
hundreds of attachments. A repack would merge several attached segments into one body and keep
each fact's attachment (its recorded position and transaction) as a column. Reads would then still
report the original recorded time, and history would be unchanged. Derived indexes are rebuildable
from the columns, so a repack can also change the index set without changing any fact.

## Measurements

Measured with `pnpm --filter triplex-stress benchmark:memory` in Node 24 with a 4 GB heap: 25
scalar attributes, 16 facts per subject with valid-time intervals, 4,000-fact chunks, and a read of
every attribute at one `validAt`. Memory counts the V8 heap and array buffers after GC. Full
tables are in the stress package README.

| 160,000 facts                  | Build (off-thread) |      Commit | First read |     Read | Memory per fact |
| ------------------------------ | -----------------: | ----------: | ---------: | -------: | --------------: |
| `main`, one `transact`         |                    | out of heap |            |          |                 |
| `main`, 4,000-fact `transact`s |                    |      40.7 s |     186 ms | 1,495 ms |          5.2 KB |
| batched KV writes, `transact`s |                    |       6.8 s |     147 ms | 1,545 ms |          5.0 KB |
| `Import.run`, summary journal  |                    |       2.8 s |     105 ms | 1,450 ms |          2.5 KB |
| Segments, built and attached   |             650 ms |       34 ms |     7.5 ms |    93 ms |            80 B |
| Prebuilt segment image         |                    |       13 ms |     7.0 ms |    85 ms |            79 B |

At 16,000 facts the same segment path builds in 100 ms, attaches in 13 ms and reads everything in
17 ms. Most of the build is the canonical encoding and SHA-256 of the content.

## What didn't pan out, and limits

- **Content hashing is the slowest part of building a segment.** The browser-safe SHA-256 now runs
  at about 55 MB/s (2.7 times faster than before). A 160,000-fact segment hashes about 15 MB of
  canonical JSON. `crypto.subtle.digest` is many times faster but asynchronous, which the
  synchronous `build` can't use. An asynchronous build could.
- **No worker helper ships.** `build` is worker-safe, but each host owns its own worker plumbing.
- **Constraint enforcement and entity-state preconditions** don't apply to attachments.
- **Reads allocate.** Each read decodes fresh fact objects; there is no decoded-fact cache for
  segment facts. That keeps memory flat at the cost of allocation per read.
- **The `transact` path still costs about 4.7 KB per fact** with the full journal, and 2.3 KB with
  the summary journal. Segments don't change ordinary writes.
