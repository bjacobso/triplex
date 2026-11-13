/**
 * One-line SQLite-backed `Triples` layers.
 *
 * ```ts
 * // in-memory
 * program.pipe(Effect.provide(SqliteTriples.layerMemory))
 *
 * // file-backed
 * program.pipe(Effect.provide(SqliteTriples.layer({ filename: "data.db" })))
 * ```
 *
 * Each call constructs a fresh client — create the layer once and share it
 * rather than rebuilding it per request.
 */

import { Layer } from "effect";
import { SqlClient } from "effect/sql";
import {
  TriplesLive,
  CurrentDialect,
  makeTripleStoreRuntimeLayer,
} from "@triplex-internal/core/internal";
import { SqlQueryExecutorLive } from "@triplex-build/triplex-sql";
import { SqliteAdapterLive, SqliteAdapterUnmigrated } from "./SqliteAdapter.js";
import { SqliteDialect } from "./dialect.js";
import { makeSqliteLayer, makeSqliteLayerReadOnly, SqliteTestLayer } from "./SqliteLayer.js";

const dialectLayer = Layer.succeed(CurrentDialect, SqliteDialect);

/** Build a `Triples` layer from a `SqlClient` layer (migrations already tapped in). */
const make = <E, R>(clientLayer: Layer.Layer<SqlClient.SqlClient, E, R>, scope: string) =>
  TriplesLive.pipe(
    Layer.provide(SqlQueryExecutorLive),
    Layer.provide(SqliteAdapterLive),
    Layer.provide(dialectLayer),
    Layer.provide(clientLayer),
    Layer.provide(makeTripleStoreRuntimeLayer(scope)),
  );

/** `make`, also outputting the exact client so other services share the database. */
const makeWithSqlClient = <E, R>(
  clientLayer: Layer.Layer<SqlClient.SqlClient, E, R>,
  scope: string,
) =>
  TriplesLive.pipe(
    Layer.provide(SqlQueryExecutorLive),
    Layer.provide(SqliteAdapterLive),
    Layer.provide(dialectLayer),
    Layer.provide(makeTripleStoreRuntimeLayer(scope)),
    Layer.provideMerge(clientLayer),
  );

/** `Triples` over a read-only client: no migration, no write succeeds. */
const makeReadOnly = (filename: string) =>
  TriplesLive.pipe(
    Layer.provide(SqlQueryExecutorLive),
    Layer.provide(SqliteAdapterUnmigrated),
    Layer.provide(dialectLayer),
    Layer.provide(makeSqliteLayerReadOnly(filename)),
    Layer.provide(makeTripleStoreRuntimeLayer(`sqlite:${filename}`)),
  );

export const SqliteTriples = {
  /** File-backed `Triples` (WAL mode, migrations applied). */
  layer: (config: { filename: string }) =>
    make(makeSqliteLayer(config.filename), `sqlite:${config.filename}`),

  /**
   * Read-only `Triples` over an existing file. The file is opened read-only,
   * no migration runs, and every write fails with `WriteError`. Acquisition
   * fails with `SchemaVersionError` if the file is not at this release's schema
   * version (zero when it has no Triplex schema); migrate it with
   * `SqliteTriples.layer` or `runMigrations` first.
   */
  layerReadOnly: (config: { filename: string }) => makeReadOnly(config.filename),

  /** In-memory `Triples` — ideal for tests and ephemeral workloads. */
  layerMemory: make(SqliteTestLayer, "sqlite::memory:"),

  /**
   * File-backed `Triples` that also outputs its `SqlClient`, so services that
   * keep their own tables in the same database (such as `SqlKeyStore`) share it.
   */
  layerWithSqlClient: (config: { filename: string }) =>
    makeWithSqlClient(makeSqliteLayer(config.filename), `sqlite:${config.filename}`),

  /** In-memory `Triples` that also outputs its `SqlClient`. */
  layerMemoryWithSqlClient: makeWithSqlClient(SqliteTestLayer, "sqlite::memory:"),

  /** Named in-memory store whose opaque cursors cannot cross another scope. */
  layerMemoryWithScope: (scope: string) => make(SqliteTestLayer, `sqlite::memory:${scope}`),
} as const;

export type SqliteTriplesLayer = ReturnType<typeof SqliteTriples.layer>;
