# TX6: entity-prefix transaction feed

Branch `feat/tx6-entity-filtered-feed`, based on
[TX2 surface follow-up #67](https://github.com/bjacobso/triplex/pull/67).
Implementation revision, raw clean evidence and PR link are pending final validation.

## Public API and adoption

Previously a consumer read `transactions({after, limit})` globally and filtered
returned records itself, decoding unrelated journal payloads. Now it supplies a
literal entity-ID prefix to discovery before hydration:

```ts
const followHomes = Effect.gen(function* () {
  const triples = yield* Triples;
  return yield* triples.transactions({ after: cursor, limit: 200, entityIdPrefix: "home:" });
});
```

The tenant protocol's `Transactions` operation accepts the same optional field.
A record matches when any fact assertion/retraction changed an entity whose ID
starts with that prefix. Multiple matching entities produce one record. Every
returned record retains its complete metadata and all changes, including changes
to other entities. Existing `after` and `next` remain exclusive global positions;
limits remain 1–1000, default 100, and an empty page has no `next`. Keep a consumer's
prefix stable when resuming its checkpoint. Missing filters preserve the global
feed; explicit empty strings match every transaction with fact changes, excluding
empty and inbox/outbox-entry-only commands.

Prefix matching is case-sensitive and literal, with no `%`, `_` or backslash
wildcards. UTF-8 bounds preserve JavaScript startsWith semantics, including a prefix
ending between an astral character's surrogate pair. Postgres/SQLite use C/binary
ordering. The API chooses the prompt's entity-prefix option; it does not introduce
entity-type membership or historical type-change rules.

Breaking pre-1.0 SPI extension: custom `StorageAdapterService` implementations
must provide `transactionIdsForEntityPrefix`, returning unique candidate transaction
IDs/positions in global order strictly after the cursor, limited to the requested
page. Read errors remain typed `ReadError`; write contracts and allocation are
unchanged. Update core, SQL/backend packages and host when using remote requests.
Changeset: `entity-prefix-transaction-feed.md`.

SQL migration **v7** adds PostgreSQL's C-collation covering changed-entity index and
analyzes triples. Host-owned SQL clients must run `runMigrations` before layer
acquisition; ordinary index creation can block writes while the index builds.
SQLite records v7 without new DDL. Its existing reference index already supplies
the needed range, as does Cloudflare's, so Cloudflare needs no migration beyond v6.
KV reuses existing changed-entity AVET keys and needs no feed backfill. The TX5
live-index backfill is required only if adopting its cheap preconditions.

## Correctness and adapter coverage

The failing portable test was run before implementation:

```sh
pnpm --filter @triplex-build/triplex-testkit exec vitest run test/fixtures.test.ts -t 'entity-prefix feeds'
```

It failed because the feed ignored the requested prefix. The oracle creates 28
multi-entity commands, a retraction and an empty command, then compares complete
filtered records to the corresponding global subsequence over multiple page sizes.
It covers duplicate matching entities, unrelated changes in a returned record,
metadata, case, literal wildcard characters, quotes/backslashes, Unicode/maximal
code points, partial surrogate prefixes, empty/missing filters, empty results and
invalid input. Cursor advancement is checked explicitly.

Host KV/SQLite regressions prove schema decoding and the tenant dispatcher preserve
the field; they failed when the schema/mapper omitted it and pass afterward. The
host Vitest config now invokes `workspaceAliases()`, so focused tests use current
sources instead of stale build output.

| Adapter       | Discovery / hydration                                                              | Verification                                                                   |
| ------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| In-memory KV  | Existing changed-entity AVET prefix; bounded selected IDs; matching envelopes only | Portable oracle, UTF-8 bound property cases, unrelated-history I/O test        |
| FoundationDB  | Same KV code and existing indexes                                                  | Common behavior tested in memory; native client absent, no native pass claimed |
| Shared SQL    | Binary prefix and position predicates, distinct candidates, batched envelope read  | Shared query builder; SQL contract and schema checks                           |
| SQLite        | Existing `idx_ref_target` reference range                                          | Portable oracle, native 10/10000 unrelated-command plans                       |
| PostgreSQL    | New covering `idx_tx_entity_prefix` with C collation                               | Full native integration, oracle and unrelated-command plan fixture             |
| Cloudflare DO | Same SQL reader over synchronous storage                                           | Native harness and real workerd, including sensitive decorator corpus          |
| Host          | Optional Transactions filter forwarded to Triples                                  | Decoded/authorized KV and SQLite request cases                                 |

KV pins the committed head before scanning immutable journal references, excluding
later commits from the scan's result. It does not populate the ordinary datom cache
with every candidate. Selected IDs remain bounded by the requested limit; journal
fact-ID order preserves the KV global feed's change ordering. SQL discovers its
candidates in one statement and batch-loads their complete envelopes. Only journal-
typed facts participate, consistently with the global feed.

Final cumulative commands:

```sh
pnpm check
pnpm pack:check
pnpm test:postgres:integration
pnpm --filter @triplex-build/triplex-cloudflare test
```

`pnpm check` passes and all **34 PostgreSQL integration tests pass**, including
the expanded prefix oracle and corrected cost fixture. Cloudflare passes 12
native-harness and two workerd tests. Clean-revision evidence and package
validation are next.
FoundationDB's `/usr/local/lib/libfdb_c.dylib` is unavailable, so no native result
is represented as passing.

## Indexed access and limits

The I/O fixture creates three related commands, each touching two matching homes
and one other entity, plus 10 or 10,000 unrelated commands. KV instrumentation
verifies only six matching changed-entity candidates are visited in either run;
no fetched META record belongs to an unrelated transaction. It also rejects use
of the global TYPE scan. Metadata-read counts are identical at both sizes.

The SQL fixture uses actual related commands and complete synthetic unrelated
command envelopes/business facts to isolate index discovery. It validates a
synthetic receipt's shape, performs actual filtered reads and continuation, and
captures the production query builder's plan after analyzing the table. SQLite
uses its existing prefix reference range at both sizes. A proposed SQLite index
was removed because the larger plan still preferred the existing index.
PostgreSQL needs the C-collation covering index for explicit binary prefix bounds.
Small-table plans may differ at the database planner's discretion; no plan is forced.

```sh
TRIPLEX_FEED_KV_EVIDENCE=/tmp/tx6-kv-io.json pnpm --filter @triplex-build/triplex exec vitest run test/operational/TransactionFeed.test.ts
TRIPLEX_FEED_PLANS=/tmp/tx6-sqlite-plans.json pnpm --filter @triplex-build/triplex-sqlite exec vitest run test/transaction-prefix-index.test.ts
TRIPLEX_FEED_PLANS=/tmp/tx6-postgres-plans.json pnpm --filter @triplex-build/triplex-postgres exec vitest run test/integration/postgresql.test.ts -t 'entity-prefix transaction candidates'
```

Raw clean-revision plans and counts will be attached after the implementation
checkpoint. These are query-plan/I/O experiments, not throughput or latency
benchmarks. B-tree traversal may grow logarithmically with index size.

**Cost limitation:** KV scans references in the matching prefix's history before
selecting the earliest positions after the cursor. SQL can also visit matching
index candidates before sorting/deduplicating. Neither path decodes unrelated
transaction envelopes, but this is not a history-independent cursor-seek guarantee.
That stronger guarantee would require another index design (for example registered
feed scopes) and is not claimed by this prefix filter. No unrelated global feed
scan is used by the application implementation.

## Premises and decisions

`transactionsForEntity` already supports one exact entity's newest-first audit
history; it did not supply the requested multi-entity prefix, ascending cursor
semantics. Existing changed-entity references were sufficient to avoid a KV
backfill and redundant SQLite/Cloudflare indexes. The API uses the settled prefix
option rather than guessing entity-type membership timing. The stronger matching-
history seek cost is explicitly left out of the claim. This package does not
change the allocator or implement either selected TX1 design investigation.
