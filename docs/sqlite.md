---
title: Building Triplex on SQLite
description: A working blueprint for an embedded Triplex storage layer using SQLite rows, indexes, and atomic SQL transactions.
pageClass: backend-blueprint
---

<p class="blueprint-eyebrow">Backend blueprint / SQLite</p>

# Building Triplex on SQLite

<p class="blueprint-lead">An embedded database underneath an embedded fact model. Durable history, attributed commands, and versioned rules in one local file.</p>

<p class="blueprint-status">Supported durable baseline · Existing adapter</p>

SQLite is the working reference for Triplex's SQL storage path. Use it for local applications,
single-process services, and a durable first implementation of a back-office domain. It is in the
default shared conformance suite. Triplex remains pre-1.0; see [current state](/current-state).

<nav class="blueprint-actions" aria-label="SQLite blueprint actions">
<a href="#run-it">Run it →</a>
<a href="#storage-mapping">Follow the storage mapping →</a>
<a href="/backends">All blueprints →</a>
</nav>

## Run it

Install the SQLite adapter with the compatible Effect version on Node.js 22 or newer:

```sh
npm install @triplex-build/triplex @triplex-build/triplex-sqlite effect@4.1.1
```

This writes a training fact and reads it through the same `Triples` service used by other backends:

```ts check
import { Effect } from "effect";
import { EntityId, Triples, string } from "@triplex-build/triplex";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";

const DatabaseLive = SqliteTriples.layer({ filename: "training.db" });
const maria = EntityId.make("worker:maria");

const program = Effect.gen(function* () {
  const triples = yield* Triples;
  const receipt = yield* triples.transact(
    [
      {
        op: "assert",
        entityId: maria,
        attribute: ":evidence/site-safety",
        value: string("site:harbor"),
        validFrom: Date.parse("2026-03-01T00:00:00Z"),
        validTo: Date.parse("2026-06-01T00:00:00Z"),
      },
    ],
    { actor: "user:dana", commandId: "training:maria-harbor:1" },
  );
  const facts = yield* triples.entity(maria, {
    validAt: Date.parse("2026-03-03T00:00:00Z"),
  });
  return { position: receipt.position, facts };
});

await Effect.runPromise(program.pipe(Effect.provide(DatabaseLive)));
```

Re-running this command raises `CommandAlreadyCommittedError` with the original transaction ID.
Handle that tag and call `transactionByCommand` with the same command ID to load the durable
receipt; the retry writes no second fact or journal entry.

Create the layer once for the database's intended lifetime. The convenience layer owns the SQLite
client, configures WAL mode, and runs the ordered Triplex migrations. Production hosts that own
DDL can use `makeSqliteLayerUnmigrated`, `makeSqliteAdapter({ autoMigrate: false })`, and the shared
SQL migration entrypoints. See [host integration](/host-integration).

## Storage mapping

| Triplex contract              | Existing SQLite representation                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| Fact identity and typed value | One `triples` row per `TripleId`, with entity, attribute, value tag, and typed value columns |
| Recorded and valid time       | `recorded_at`, `retracted_at`, `valid_from`, and `valid_to`                                  |
| Exact commit visibility       | `recorded_position` and `retracted_position` on each row                                     |
| Ordered command boundary      | Transactional `triplex_commit_position` row                                                  |
| Retry identity                | Unique command claim in `triplex_command_receipts`                                           |
| Attributed journal            | `_Transaction` facts and typed changes stored with the application writes                    |
| Entity projections            | Content-addressed blobs and entity snapshot tables, when composed with snapshot services     |
| Datalog                       | Shared SQL compiler/executor with the SQLite dialect                                         |

The physical schema stores each assertion separately. Domain attributes such as
`:evidence/site-safety` remain data, so applications do not need a physical table per entity type.
Indexes cover entity lookup, attribute/value lookup, references, temporal reads, and commit
visibility. The additive v2 migration adds the shared numeric range index.

## One command, one SQL transaction

The adapter executes Triplex's transaction callback on the ambient Effect SQL transaction.
Command claiming, position allocation, constraint checks, fact changes, and journal changes belong
to that same boundary. A rejected command must leave none of them committed.

For Maria's correction, the adapter marks the old assertion's retraction time, transaction, and
position, then inserts the corrected assertion and journal changes. The assertion row is retained.
Historical reads filter both clocks; query pages additionally use the pinned commit position so
later retractions cannot remove a fact from an older page.

Keeping timestamps and positions separate matters when multiple commands share a recorded
millisecond. The cursor contract relies on exact commit visibility.

## Read the implementation

Follow these modules in order:

1. [SQLite layer and resource lifetime](https://github.com/bjacobso/triplex/blob/main/packages/sqlite/src/SqliteLayer.ts)
2. [SQLite storage adapter](https://github.com/bjacobso/triplex/blob/main/packages/sqlite/src/SqliteAdapter.ts)
3. [Shared SQL schema](https://github.com/bjacobso/triplex/blob/main/packages/sql/src/schema.ts) and
   [migrations](https://github.com/bjacobso/triplex/blob/main/packages/sql/src/migrations.ts)
4. [Triples composition](https://github.com/bjacobso/triplex/blob/main/packages/sqlite/src/SqliteTriples.ts)

Run `pnpm --filter @triplex-build/triplex-sqlite test` from a repository checkout for the adapter's
tests; `pnpm --filter triplex-integration-tests test` runs the shared backend corpus. Conformance is a
behavioral boundary, not a promise about every workload or storage failure. Backup, restore,
deployment migrations, and process lifecycle belong to your application.

Continue with the [SQLite quickstart](/getting-started#use-durable-sqlite), or use this implementation
as a reference while [building a custom runtime](/custom-runtimes).
