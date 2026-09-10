# Host integration

Triplex can provide the fact, temporal-query, configuration, derivation, and audit substrate for
an application that also owns relational operational records. The host remains responsible for
authentication, authorization, HTTP contracts, durable work, response caching, external effects,
and product-specific invariants.

The executable companion is
[`examples/compliance-host`](https://github.com/bjacobso/triplex/tree/main/examples/compliance-host).
Despite its focused scenario, it uses only generic Triplex primitives: content-addressed
configuration, temporally scoped facts, Datalog derivations, provenance, reconciliation,
hypothetical overlays, and consumer checkpoints.

Treat [`current-state.md`](current-state.md) as the release-readiness contract. PostgreSQL passes
the shared conformance and isolation suites, but remains a production candidate while Triplex is
pre-1.0.

## Responsibility boundary

Triplex provides:

- atomic fact assertions and retractions with optimistic preconditions;
- independent recorded and valid time;
- structural Datalog queries and snapshot-stable pagination;
- a causal transaction journal with actor, command, correlation, causation, and config pins;
- content-addressed configuration releases and movable refs;
- derivation candidates, provenance, materialization, and explicit freshness; and
- database-scoped in-memory, SQLite, and PostgreSQL runtimes.

The host provides:

- authentication and authorization before selecting a database;
- mapping from its isolation boundary to a validated `DatabaseId`;
- operational tables, response caches, inboxes, outboxes, and delivery workers;
- domain command validation and higher-order business invariants;
- lifecycle semantics for durable tasks, cases, evidence, or other work; and
- migration orchestration, monitoring, retention, and recovery policy.

These are database guarantees, not authorization guarantees. Resolve the caller's access and then
select a server-owned database mapping before exposing `Triples` to application code.

## Choose a runtime

| Host shape                                      | Public Triplex entry point                       |
| ----------------------------------------------- | ------------------------------------------------ |
| Ephemeral or test database                      | `KvTriples.layerWithScope(databaseId)`           |
| One SQLite database per isolation boundary      | `SqliteTriples.layer({ filename })`              |
| Standalone PostgreSQL with a Triplex-owned pool | `PgTriples.layerFromUrl(url)`                    |
| Host-owned Effect SQL pool                      | `PgTriples.layerFromSqlClient({ scope })`        |
| Server-mapped PostgreSQL database               | `PgTriples.layerForDatabase(config, databaseId)` |

Application code should depend on `Triples`, not the internal `StorageAdapter`. The
`@triplex-build/triplex/internal` entry point is an adapter SPI and is not required for host
integration.

## One database per isolation boundary

Persist a server-owned mapping from the host's isolation key to a validated Triplex `DatabaseId`.
Do not derive authorization or physical schema names directly from request input. At request
entry:

1. authenticate the actor and authorize the requested operation;
2. load the trusted `DatabaseId` mapping;
3. construct or obtain the cached database runtime;
4. provide its scoped `SqlClient` and `Triples` services to the request program; and
5. keep authorization checks in the host command and query layer.

For PostgreSQL, `PgTriples.layerForDatabase` creates a collision-resistant schema-bound pool,
provides its exact `SqlClient` alongside `Triples`, and embeds the logical database scope in
pagination cursors. Never use the registry or system client as an application fact client.

SQLite callers should allocate one file per isolation boundary:

```ts
const DatabaseLive = SqliteTriples.layer({
  filename: `/var/lib/example/triplex/${databaseId}.sqlite`,
});
```

Tests and ephemeral programs should name the in-memory scope explicitly:

```ts
const DatabaseLive = KvTriples.layerWithScope(databaseId);
```

Cache runtimes by the trusted `DatabaseId`, not an unchecked request string. Never batch requests
across database boundaries.

## Share a PostgreSQL transaction

A host-owned Effect SQL client can back Triplex without a hidden second pool:

```ts
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { EntityId, Triples, string } from "@triplex-build/triplex";
import { PgTriples, makePostgresqlLayerUnmigratedFromUrl } from "@triplex-build/triplex-postgres";

const HostSql = makePostgresqlLayerUnmigratedFromUrl(process.env.DATABASE_URL!);
const DatabaseLive = PgTriples.layerFromSqlClient({ scope: "host/main" }).pipe(
  Layer.provideMerge(HostSql),
);

const command = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const triples = yield* Triples;

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT INTO host_records (id) VALUES ('record:1')`;
      yield* triples.transact(
        [
          {
            op: "assert",
            entityId: EntityId.make("record:1"),
            attribute: ":record/status",
            value: string("accepted"),
          },
        ],
        { actor: "user:1", commandId: "command:1" },
      );
      yield* sql`INSERT INTO host_outbox (id) VALUES ('delivery:1')`;
    }),
  );
}).pipe(Effect.provide(DatabaseLive));
```

The host statements and nested `Triples.transact` resolve Effect SQL's same fiber-local
transaction connection. A failure on either side rolls back the relational rows, Triplex facts,
journal envelope, command receipt, commit position, and outbox row together. Nested transactions
retain Effect SQL savepoint semantics.

`layerFromSqlClient` creates no pool and runs no DDL. The explicitly named
`layerFromSqlClientMigrated` variant is a provisioning convenience, not the default production
boundary.

## Host-controlled migrations

`@triplex-build/triplex-sql` exports the ordered `migrations` definitions and `runMigrations`. Run them
from the host's deployment process against the same database or scoped schema before constructing
an unmigrated runtime. Triplex records its state in `triplex_schema_migrations`, avoiding the
host's migration table.

Triplex currently publishes one complete greenfield v1 schema. It does not upgrade databases
created by unpublished development builds. A host adopting an existing EAV store should rehearse
the copy against production-shaped data, preserve every assertion and retraction, rebuild journal
positions deterministically, and compare live and historical reads before cutover.

## Compile application configuration

The host can compile its own ergonomic DSL into independently addressed Triplex nodes:

```ts
const RecordName = Attribute.text(":record/name");

const Record = EntityType.make("Record", {
  attributes: {
    name: Attribute.use(RecordName, { required: true }),
  },
});
```

The attribute node owns its global key and value type. The entity-type node references it and owns
usage-local constraints such as requiredness and cardinality. Forms, policies, actions,
permissions, integrations, and views can reference those same keys in one `ConfigStore.commit`.
Store the resulting `ConfigSnapshot` ID on operational transactions through
`meta.configSnapshot`.

`EntityValidation` records queryable observations for attribute cardinality, required facts,
reference target types, and uniqueness. The same collected `GraphConstraint` definitions can be
passed to `Triples.transact` for atomic enforcement. The host remains responsible for
authorization and higher-order policy invariants.

## Batch entity reads

Build an Effect `RequestResolver` above `Triples.entities(ids, basis?)`:

1. partition requests by an already authorized database and temporal basis;
2. deduplicate entity IDs within each partition;
3. call `entities` once per partition; and
4. associate every result, including missing entities, with its original request.

KV performs indexed entity lookups. SQLite and PostgreSQL use bounded parameterized queries. The
host should schema-decode the returned attribute sets into its own domain type.

## Consume the journal

Translate a validated command into `TransactOp` values and call one `Triples.transact` with:

- `actor` from the authenticated principal;
- the idempotency key as `commandId`;
- `correlationId` and `causationId` from the host operation context;
- the pinned `configSnapshot`;
- graph constraints from that exact snapshot in `enforce`; and
- a `TripleLive` precondition for each optimistic fact being replaced.

Use `transaction(txId)` to construct an audit response. Retraction changes include the old typed
value and original assertion transaction; assertions include the replacement. Command IDs are
atomically unique within one Triplex database. A duplicate produces
`CommandAlreadyCommittedError`, and `transactionByCommand` retrieves the durable receipt.

Durable consumers page `transactions({ after: checkpoint })`, perform idempotent work, and advance
`ConsumerCheckpoint` only after their effects commit. The feed is authoritative; an in-process
change signal is only a wake-up hint.

For an entity audit view, page `transactionsForEntity(entityId, { limit })`. Preserve the returned
`snapshotPosition` and `nextBeforePosition` when requesting the next page. Every record already
contains actor, command, correlation, causation, config snapshot, time, position, and complete
typed assertion and retraction changes. Do not create a second audit log.

## Remaining limitations

- Authorization and general cross-entity Datalog invariants remain host-owned.
- Inbox and outbox records, response caching, retries, and timer delivery remain host-owned.
- Derivation provenance rejects recursive rules, disjunction, aggregation, and dynamic attributes
  rather than returning an incomplete explanation.
- Entity snapshots and derivation materializations are projections. Inspect their source position
  and freshness instead of treating absence as current truth.
- Dynamic-attribute derivations fall back to journal replay and should not serve hot-path
  materializers.
- FoundationDB and Cloudflare are experimental and are not production targets for this guide.
- Stable adoption should wait for a stable package release, a rehearsed data copy where applicable,
  and application-level shadow comparisons.
