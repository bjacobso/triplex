# Design note: journal change references instead of copies

Status: built in 0.5.0 (ask 0019, #104). This note proposed references inside one journal fact; 0.5.0
went further and moved the whole journal out of `triples`, as the last section of the proposal
suggested. "As built" describes what shipped; the original proposal follows it unchanged.

## As built (0.5.0)

### Storage

- **SQL (SQLite, PostgreSQL; Cloudflare by a DDL-only migration).**
  - `triplex_transactions` has one row per transaction:
    - `tx_id` is the primary key;
    - `position` is unique;
    - then `instant`, `actor`, `command_id` (unique), `correlation_id`, `causation_id` and
      `config_snapshot`;
    - `changes` is a JSON array of `[tripleId, op]` in commit order.
  - `triplex_transaction_entities(entity_id, position, tx_id)` has one row per changed entity. Its
    primary key is `(entity_id, position)`, and `position` has its own index.
  - The unique `command_id` replaces the command receipts table and keeps first-writer-wins.
  - `triplex_commit_position` is still the position allocator.
- **KV (in-memory and FoundationDB).** A journal keyspace maps:
  - a position to its entry;
  - a transaction ID to its position;
  - an entity and position to the position;
  - a command to its position;

  plus the existing instant trie. Journal datoms no longer enter the fact indexes.

- **Rows written.** A 10-attribute, one-entity commit writes 10 fact rows and 2 journal rows, where
  0.4 wrote 25 rows into `triples`. The journal rows enter only the journal tables' own keys and
  indexes.

### Reads

- **Transaction records.** Each page of records is rebuilt with one batched primary-key read of the
  referenced facts (`WHERE id IN (…)`, chunked). `TransactionChange` keeps its shape, and sealed
  values come back as they would from the fact.
- **Datalog over `:_tx/*`.**
  - A pattern with a constant `:_tx/*` attribute reads a per-attribute source over the journal
    tables.
  - A pattern with a variable attribute reads `triples` together with the `triplex_journal_facts`
    view. SQLite materializes a `UNION ALL` view inside a join, so a query with up to three such
    patterns is compiled once per split between the two sources, and the results are combined.
  - The semantics are unchanged: a recorded cut, and no valid-time filter.
  - `:_tx/change` is no longer an attribute.

### Results

Measured on SQLite with the stress scripts:

| Measure                                    |        0.4 |        0.5 |
| ------------------------------------------ | ---------: | ---------: |
| Bytes per asserted triple, SQLite          |      2,023 |        697 |
| Bytes per asserted triple, PostgreSQL      |      2,428 |      1,044 |
| Write time per 10-triple transaction, mean | 2.1–2.3 ms | 0.9–1.0 ms |
| SQL statements per commit                  |         22 |          9 |

See [Storage footprint](../storage-footprint.md).

### Where the build differs from this note

- **The journal has its own tables**, not a `:_tx/changes` fact in `triples`. That was "the larger
  write-time lever" below. It also means journal rows no longer skew the statistics of fact indexes.
- **No migration from 0.4.** The SQL migrations collapse into one baseline, and a 0.4 database is
  refused with `SchemaVersionError`. Cloudflare upgrades in place; transactions it committed before
  the upgrade are not visible through journal reads.
- **Unjournaled system writes cannot carry a command ID**, because there is no journal row to hold
  it.
- **`[?tx :_tx/actor "x"]` with no bound transaction scans `triplex_transactions`**, because there
  is no index on actor, correlation or causation. Add one if a host needs that query to be fast.

## Original proposal

### Today

Every transaction records one `:_tx/change` fact per changed fact on the transaction entity. Its
JSON value copies the change in full: operation, triple ID, entity, attribute, entity type, value,
valid and recorded times, retraction time and both transaction IDs. `Triples.transaction`,
`transactions`, `transactionByCommand` and `transactionsForEntity` build `TransactionRecord.changes`
from these copies alone, so the journal is self-contained.

Measured in [Storage footprint](../storage-footprint.md): the copies are 486 bytes per asserted
triple on SQLite and 523 on PostgreSQL, about a fifth of the total, and up to 21% of write time.
Their write cost comes from their index entries, not their bytes.

### Proposal

Keep one journal fact per transaction, `:_tx/changes`, whose value is the ordered list of
`[tripleId, op]` pairs. Build a `TransactionRecord`'s changes by reading those facts by ID, which
are immutable apart from their retraction fields (retraction time, position and transaction), all
of which a retract change needs.

Expected effect: the copies' bytes drop from about 490 to about 40 per triple (a triple ID and an
operation in one shared row), and their write cost drops to one indexed row per transaction instead
of one per change, close to the 21% upper bound.

### What stops being possible

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

### What gets simpler

- **Erasure and rotation.** S3 had to strip blind tokens from the copies, and `Sensitive.rewrap`
  rewrites each fact's journal copies along with the fact. With references, a fact rewrite is
  automatically what the journal shows.
- **Storage.** One journal row per transaction instead of one per change.

### Read cost

A page of transaction records gains one batched primary-key read for its referenced facts
(`SELECT … WHERE id IN (…)`): for a page of 100 transactions of 10 changes, one extra indexed read
of 1,000 rows by primary key. The journal page seek (#96) is unchanged. Live queries and the change
feed use `TransactionRecord.changes`, so they see the same data at the same cost as other journal
readers.

### Work

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

### The larger write-time lever

The [write cost](../storage-footprint.md#write-cost) measurements show that which indexes journal
rows enter matters more than how big they are: keeping journal rows out of the indexes no journal
read uses would save 32–37% of write time, against 21% for removing the copies. That needs more than
partial-index predicates, because fact queries do not say "not a journal row", so a planner could
not use such an index for them. It means either a journal table of its own or a predicate added to
every fact read path. It belongs in the same 0.5.0 design, and should be decided together with this
note.
