# @triplex-build/triplex-postgres

The PostgreSQL backend for Triplex, built on `@effect/sql-pg`.

The `@triplex-build` packages are not yet published. Evaluate this workspace package from a source
checkout. It requires Node.js 22 or newer and a PostgreSQL connection URL.

```ts
import { PgTriples } from "@triplex-build/triplex-postgres";

const TriplesLive = PgTriples.layerFromUrl(process.env.DATABASE_URL!);
```

That standalone convenience owns a pool and applies Triplex migrations. A production host that
already owns an Effect SQL pool can give Triplex the same ambient client without importing the
internal adapter SPI:

```ts
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Triples } from "@triplex-build/triplex";
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
      yield* triples.transact(operations, metadata);
      yield* sql`INSERT INTO host_outbox (id) VALUES ('delivery:1')`;
    }),
  );
}).pipe(Effect.provide(DatabaseLive));
```

`layerFromSqlClient` creates no hidden pool and performs no DDL. The host SQL, Triplex facts,
journal, command claim, and commit position use the same fiber-local transaction connection.
Failures roll the whole unit back and nested transactions retain Effect SQL savepoint semantics.
`layerFromSqlClientMigrated` is an explicitly named setup convenience.

For a server-owned database mapping, use a validated `DatabaseId`:

```ts
import { DatabaseId } from "@triplex-build/triplex";
import { PgTriples } from "@triplex-build/triplex-postgres";

const DatabaseLive = PgTriples.layerForDatabase(postgresConfig, DatabaseId.make("customer-a"));
```

Logical IDs map to collision-resistant schema names, every physical connection is bound at
startup to exactly that schema, and the logical scope is included in query-page cursors. The host
must resolve `DatabaseId` from authenticated server-owned state, not raw request input.
`layerForDatabase` expects a provisioned schema and runs no migration;
`layerForDatabaseMigrated` explicitly creates and migrates it for setup tools and tests. The
generic core `DatabaseManager` remains available for Triples-only dynamic databases, while this
package-level API is the boundary for hosts that also need the scoped `SqlClient`.

Ordered migration definitions and `runMigrations` are exported by `@triplex-build/triplex-sql` for
host deployment tooling. Triplex uses its own `triplex_schema_migrations` table.

PostgreSQL passes the shared conformance and multi-connection isolation integration suite in CI.
Treat this package as a production candidate rather than a supported default.

MIT © 2026 Ben Jacobson.
