---
"@triplex-build/triplex": minor
---

**Breaking: new storage layout; 0.4 databases are refused.** The transaction journal moves out of the
`triples` table into its own tables: `triplex_transactions` (one row per transaction: position, instant,
actor, command, correlation, causation, config snapshot and the ordered `[tripleId, op]` references to the
changed facts) and `triplex_transaction_entities` (one row per changed entity). Transaction records are
rebuilt from the referenced facts with one batched primary-key read and keep their exact shape. A
10-attribute SQLite commit writes its 10 fact rows plus two journal rows instead of 25 rows into
`triples`, which cuts write time per transaction by about two thirds and removes the journal's per-fact
value copies from storage. The command receipts table is gone: the unique `command_id` of the journal row
keeps first-writer-wins.

There is no migration from 0.4. The SQL migrations collapse into one new baseline, and every SQLite and
PostgreSQL layer, migrating or not, and `runMigrations` fail with `SchemaVersionError` on a database with
any other schema history, including every database written by 0.4 or earlier: start a fresh database.
The frozen Cloudflare backend upgrades in place by adding the journal tables; transactions it committed
before the upgrade are not visible through the journal reads. The 0.4 indexes
`idx_journal_instant_position`, PostgreSQL's `idx_tx_entity_prefix`, `idx_attribute` and
`idx_recorded_position` are not created.

Other changes that follow:

- Datalog over `:_tx/*` keeps working with the same results, including the fourth term and patterns with a
  variable attribute, through journal sources and the `triplex_journal_facts` view. **`:_tx/change` is no
  longer a Datalog attribute**, and triple-level reads (`match`, `entity`, `history`, `get`) no longer
  return `_Transaction` facts; use `transaction`, `transactions` or Datalog.
- `Sensitive.rewrap` no longer rewrites journal copies and `RewrapReport.journalCopies` is removed;
  `Triples.rewriteValues` accepts only sealed values. `why` no longer compares facts with journal copies.
- A retract-pattern that names reserved data (`_Transaction`, `:_tx/*`, `_triplex/`) is refused.
- An unjournaled system write cannot carry a command ID; consumer checkpoints initialize with an
  `EntityAbsent` precondition instead.
- `StorageAdapter` replaces `claimCommand`, `transactionIdsAfter` and `transactionIdsForEntityPrefix` with
  `appendTransaction`, `transactionEntry`, `transactionEntryByCommand`, `transactionEntriesAfter`,
  `transactionEntriesForEntityPrefix`, `transactionEntriesForEntity` and `getByIds`.

Fixed: two connections in one process that open a new SQLite file at the same time no longer fail with
`LockTimeoutError` ("database is locked"). The synchronous driver waited out its busy timeout on the only
JavaScript thread while the first connection held the schema-setup write lock across an Effect yield, so
the first could never finish. Schema setup is now serialized per file within a process; the second opener
waits, then finds the schema ready.
