# Design note: journal change references instead of copies

Status: built in 0.5.0 (ask 0019), together with the journal table of its own that the last section calls for. The journal is `triplex_transactions` plus `triplex_transaction_entities`; see [Storage footprint](../storage-footprint.md). The text below is the original proposal.

## Today

Every transaction records one `:_tx/change` fact per changed fact on the transaction entity. Its
JSON value copies the change in full: operation, triple ID, entity, attribute, entity type, value,
valid and recorded times, retraction time and both transaction IDs. `Triples.transaction`,
`transactions`, `transactionByCommand` and `transactionsForEntity` build `TransactionRecord.changes`
from these copies alone, so the journal is self-contained.

Measured in [Storage footprint](../storage-footprint.md): the copies are 486 bytes per asserted
triple on SQLite and 523 on PostgreSQL, about a fifth of the total, and up to 21% of write time.
Their write cost comes from their index entries, not their bytes.

## Proposal

Keep one journal fact per transaction, `:_tx/changes`, whose value is the ordered list of
`[tripleId, op]` pairs. Build a `TransactionRecord`'s changes by reading those facts by ID, which
are immutable apart from their retraction fields (retraction time, position and transaction), all
of which a retract change needs.

Expected effect: the copies' bytes drop from about 490 to about 40 per triple (a triple ID and an
operation in one shared row), and their write cost drops to one indexed row per transaction instead
of one per change, close to the 21% upper bound.

## What stops being possible

- **Replaying the journal without the facts.** Today a transaction record can be served from the
  journal facts alone. After the change it needs the referenced facts. Nothing in Triplex replays
  the journal without the `triples` table, and facts are never deleted, so no current feature is
  lost. Any future fact compaction, archive or partial export would have to keep every fact a
  retained journal entry references, or materialize the copy at that point.
- **Exporting the journal on its own.** An export of `transactions()` still works, because it goes
  through the read API, which joins. A raw copy of only the `_Transaction` rows would no longer be a
  complete record.
- **Detecting drift between a fact and its journal copy.** `why` checks today that a fact matches its
  journal copy. With references there is nothing to compare, so that check becomes vacuous; it
  never caught a real divergence, because facts are immutable apart from retraction.

## What gets simpler

- **Erasure and rotation.** S3 had to strip blind tokens from the copies, and `Sensitive.rewrap`
  rewrites each fact's journal copies along with the fact. With references, a fact rewrite is
  automatically what the journal shows.
- **Storage.** One journal row per transaction instead of one per change.

## Read cost

A page of transaction records gains one batched primary-key read for its referenced facts
(`SELECT … WHERE id IN (…)`): for a page of 100 transactions of 10 changes, one extra indexed read
of 1,000 rows by primary key. The journal page seek (#96) is unchanged. Live queries and the change
feed use `TransactionRecord.changes`, so they see the same data at the same cost as other journal
readers.

## Work

About two to three days, which is why this waits for 0.5.0:

- core: write the reference row instead of copies (`metadataInputs`), and build records from
  references with a batched fact read in `TriplesLive` and `KvTriplesLive`; keep `TransactionChange`
  as it is;
- every backend's journal reads, including the frozen Cloudflare and FoundationDB adapters, which
  share the core record builder but need their conformance suites rerun;
- a SQL migration that folds existing `:_tx/change` rows into one `:_tx/changes` row per transaction
  (`json_group_array` on SQLite, `jsonb_agg` on PostgreSQL), and deletes the old rows;
- simplify `Sensitive.rewrap` and `why`, and update the journal, erasure and rotation suites;
- re-measure footprint and write cost.

## The larger write-time lever

The [write cost](../storage-footprint.md#write-cost) measurements show that which indexes journal
rows enter matters more than how big they are: keeping journal rows out of the indexes no journal
read uses would save 32–37% of write time, against 21% for removing the copies. That needs more than
partial-index predicates, because fact queries do not say "not a journal row", so a planner could
not use such an index for them. It means either a journal table of its own or a predicate added to
every fact read path. It belongs in the same 0.5.0 design, and should be decided together with this
note.
