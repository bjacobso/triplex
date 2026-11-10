# TX4: transactional inbox and outbox entries

Implementation: `feat/tx4-operational-entries`, based on draft #64
(`design/tx1-scoped-concurrency`), following #63 → #62 → #61 → #60 → #59.
PR and final tested revision will be recorded after validation. No allocator
proposal is implemented by this change.

## API and adoption

Previously consumers stored journal entries as home facts, loaded that growing
entity to find pending work, and maintained acknowledgement facts themselves.
Now they compose operational records directly with their application command:

```ts
const commit = Effect.gen(function* () {
  const triples = yield* Triples;
  yield* triples.transact(
    [
      { op: "assert", entityId: home, attribute: ":home/status", value: string("ready") },
      Outbox.append({ scope: home, idempotencyKey: "command:1:send", payload: intent }),
    ],
    { commandId: "command:1" },
  );
  return yield* Outbox.pending(triples, { scope: home, limit: 25 });
});
```

Import `Inbox`/`Outbox` from `@triplex-build/triplex/operational`. Omit scope for
all pending work in a database. Both namespaces provide `append`, `id`, `pending`,
`acknowledge`, and `get`. Acknowledge through `transact` after successful delivery;
`get` continues to return the original payload, append receipt, and first
acknowledgement receipt. Pending reads are at-least-once discovery, without claims,
leases, vendor integration, or implicit delivery confirmation.

Identity includes direction, entity scope, and key. Same identity plus same
canonical JSON payload is an entry no-op, including after acknowledgement. A
changed payload raises `OperationalEntryConflictError` with `isRetryable: false`;
facts, entries, journal, command receipt, and position roll back together.
Transaction-level receipts and positions still advance for successful duplicate
operations. Pending order is original position then ASCII content ID. Limits are
1–1000 (default 100), with limit+1 lookahead; cursors bind database, direction, and
scope and survive acknowledgement of their last entry. Start a fresh drain after
exhaustion. Delivery crashes redeliver exactly the canonical stored payload.

Breaking pre-1.0 extensions: custom storage adapters need four persistence methods;
custom `TriplesService` implementations need two reads; exhaustive `TransactOp`
switches need two variants, and explicit transaction error unions need the new
conflict. SQL migration **v5** and Cloudflare migration **v6** add the table and
partial pending indexes. Hosts owning SQL migrations must run `runMigrations`
before acquiring the updated layer. KV needs no data migration. See Changeset
`transactional-operational-entries.md` and the checked example in operational
primitives for the complete adoption contract.

Payloads belong to the host and bypass attribute-based `Sensitive` policies.
Encrypt sensitive contents before append. Entries link to receipts but do not
copy payloads into `:_tx/change`; fact-only journal changes, Datalog, snapshots,
and temporal fact cuts retain their existing meanings.

## Coverage and validation

| Adapter       | Implementation                                   | Verification                                                                  |
| ------------- | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| In-memory KV  | Separate primary/global/scoped prefixes          | Shared conformance; 10/10000 operation counts; cross-database cursor binding  |
| Shared SQL    | One query builder and portable DDL               | SQL contract, SQLite and PostgreSQL plans                                     |
| SQLite        | Shared storage inside native transaction         | Full shared suite, migrations and index/cost fixture                          |
| PostgreSQL    | Shared storage inside ambient native transaction | Full integration suite, races, outer host rollback and index/cost fixture     |
| Cloudflare DO | Shared storage over synchronous cursor runner    | Native SQLite harness and real workerd, including sensitive decorator         |
| FoundationDB  | Same KV storage and transaction code             | Shared in-memory logic verified; native client absent, no native pass claimed |

The first portable test was written and run before implementation:

```sh
pnpm --filter @triplex-build/triplex-testkit exec vitest run test/fixtures.test.ts -t 'inbox/outbox'
```

It failed at `Outbox.append` because the API was absent. The portable suite now
checks canonical equality, global/scoped pagination with same-position ties,
concurrent same/different payload keys, acknowledgement and append rollback,
crash redelivery, invalid payloads/limits/cursors, direction separation, duplicate
append after acknowledgement, same-transaction append+acknowledgement, and exact
control-character/UTF-16 identity round trips. The PostgreSQL host test additionally
aborts after nested Triplex success and verifies both host SQL and Triplex records
roll back, then verifies their shared successful commit.

Commands used for final cumulative validation:

```sh
pnpm check
pnpm pack:check
pnpm test:postgres:integration
pnpm --filter @triplex-build/triplex exec vitest run test/operational/Entries.test.ts
```

Final clean-revision checks are in progress. Previous cumulative runs pass,
including real workerd, all package typechecks, checked Markdown, and 11 clean
consumer tarballs. FoundationDB's missing `/usr/local/lib/libfdb_c.dylib` remains
an infrastructure limitation; its native suite has not passed.

## Indexed cost evidence

The reproducible fixture seeds 10 and 10,000 acknowledged records plus 128
unrelated pending scopes. Seeding bypasses receipt creation deliberately to isolate
entry-index costs; IDs, canonical payloads and acknowledgement metadata retain the
valid entry shape. It then performs actual public append, scoped/global pending,
and acknowledgement calls. Plans use the production shared query builder.
PostgreSQL reads use `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`; acknowledgement uses
non-mutating `EXPLAIN (FORMAT JSON)`. SQLite uses `EXPLAIN QUERY PLAN`.

```sh
TRIPLEX_OPERATIONAL_PLANS=/tmp/tx4-sqlite-plans.json pnpm --filter @triplex-build/triplex-sqlite exec vitest run test/operational-entry-index.test.ts
TRIPLEX_OPERATIONAL_PLANS=/tmp/tx4-postgres-plans.json pnpm --filter @triplex-build/triplex-postgres exec vitest run test/integration/postgresql.test.ts -t 'inbox/outbox operations indexed'
```

Clean-revision raw plans and illustrative timings will be attached after the
implementation checkpoint. Timings are single observations, not throughput or
statistical latency claims. Plans and logical operation counts establish bounded
candidate work; B-tree traversal can grow logarithmically with index size.

KV instrumentation counts only entry-prefix storage operations, excluding ordinary
transaction journaling. Both sizes produce exactly:

| Operation                           | Point reads | Sets | Deletes | Ranges / returned entries |
| ----------------------------------- | ----------: | ---: | ------: | ------------------------: |
| Append                              |           1 |    3 |       0 |                     0 / 0 |
| Scoped and global pending, combined |           2 |    0 |       0 |                     2 / 2 |
| Acknowledge                         |           2 |    1 |       2 |                     0 / 0 |

Each pending range has limit 2 for a public limit of 1. Acknowledged history is
absent from those ranges. These are storage-port operation counts, not a claim
that the in-memory backend's internal allocation or native FoundationDB costs are
constant. SQL point lookups and partial indexes supply the corresponding indexed
access paths. PostgreSQL may choose a sequential scan for very small tables; the
10,000-history case requires indexed access. No index is forced in the fixture.

## Premise and decisions

The requested primitive was absent; the motivating need was confirmed. This
implementation keeps the existing global serialized transaction boundary, so its
position/ordering guarantees and known allocation contention are unchanged. It
does not depend on owner decisions in allocator drafts #63/#64. Routine API choices
(identity scope, canonical equality, append/ack ordering, live cursor semantics,
and retained history) are explicit above and in public documentation. No additional
owner decision blocks this package.
