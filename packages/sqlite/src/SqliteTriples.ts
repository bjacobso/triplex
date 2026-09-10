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
import type { SqlClient } from "effect/unstable/sql";
import {
  TriplesLive,
  CurrentDialect,
  makeTripleStoreRuntimeLayer,
  RuntimeServicesLive,
} from "@triplex-build/triplex/internal";
import { SqlQueryExecutorLive } from "@triplex-build/triplex-sql";
import { SqliteAdapterLive } from "./SqliteAdapter.js";
import { SqliteDialect } from "./dialect.js";
import { makeSqliteLayer, SqliteTestLayer } from "./SqliteLayer.js";

const dialectLayer = Layer.succeed(CurrentDialect, SqliteDialect);

/** Build a `Triples` layer from a `SqlClient` layer (migrations already tapped in). */
const make = <E, R>(clientLayer: Layer.Layer<SqlClient.SqlClient, E, R>, scope: string) =>
  TriplesLive.pipe(
    Layer.provideMerge(SqlQueryExecutorLive),
    Layer.provideMerge(SqliteAdapterLive),
    Layer.provideMerge(dialectLayer),
    Layer.provideMerge(clientLayer),
    Layer.provide(makeTripleStoreRuntimeLayer(scope)),
    Layer.provideMerge(RuntimeServicesLive),
  );

export const SqliteTriples = {
  /** File-backed `Triples` (WAL mode, migrations applied). */
  layer: (config: { filename: string }) =>
    make(makeSqliteLayer(config.filename), `sqlite:${config.filename}`),

  /** In-memory `Triples` — ideal for tests and ephemeral workloads. */
  layerMemory: make(SqliteTestLayer, "sqlite::memory:"),

  /** Named in-memory store whose opaque cursors cannot cross another scope. */
  layerMemoryWithScope: (scope: string) => make(SqliteTestLayer, `sqlite::memory:${scope}`),
} as const;

export type SqliteTriplesLayer = ReturnType<typeof SqliteTriples.layer>;
