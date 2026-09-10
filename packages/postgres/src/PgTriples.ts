/**
 * One-line PostgreSQL-backed `Triples` layers.
 *
 * ```ts
 * program.pipe(Effect.provide(PgTriples.layer({ database: "app" })))
 * program.pipe(Effect.provide(PgTriples.layerFromUrl(process.env.DATABASE_URL!)))
 * ```
 *
 * Each call constructs a fresh connection pool — create the layer once and
 * share it rather than rebuilding it per request.
 */

import { Layer } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import {
  TriplesLive,
  CurrentDialect,
  makeTripleStoreRuntimeLayer,
} from "@triplex-build/triplex/internal";
import { SqlQueryExecutorLive } from "@triplex-build/triplex-sql";
import { PostgresqlAdapterLive, PostgresqlAdapterUnmigrated } from "./PostgresqlAdapter.js";
import { PostgresqlDialect } from "./dialect.js";
import {
  makePostgresqlLayer,
  makePostgresqlLayerFromUrl,
  type PostgresqlConfig,
} from "./PostgresqlLayer.js";
import type { DatabaseId } from "@triplex-build/triplex";
import {
  makePostgresqlDatabaseSqlLayer,
  makePostgresqlDatabaseSqlLayerMigrated,
} from "./PostgresqlBackend.js";

const dialectLayer = Layer.succeed(CurrentDialect, PostgresqlDialect);

export interface PgTriplesFromSqlClientOptions {
  /** Stable identity included in pagination cursors. */
  readonly scope: string;
}

/** Build `Triples` from the ambient SQL client without creating a pool. */
const fromSqlClient = (scope: string, migrate: boolean) =>
  TriplesLive.pipe(
    Layer.provide(SqlQueryExecutorLive.pipe(Layer.provide(dialectLayer))),
    Layer.provide(migrate ? PostgresqlAdapterLive : PostgresqlAdapterUnmigrated),
    Layer.provide(makeTripleStoreRuntimeLayer(scope)),
  );

/** Build `Triples` and retain the exact client layer for host SQL use. */
const make = <E, R>(
  clientLayer: Layer.Layer<SqlClient.SqlClient, E, R>,
  scope: string,
  migrate: boolean,
) => fromSqlClient(scope, migrate).pipe(Layer.provideMerge(clientLayer));

const scopeFromConfig = (config: PostgresqlConfig): string =>
  `postgresql://${config.host ?? "localhost"}:${config.port ?? 5432}/${config.database}`;

const scopeFromUrl = (url: string): string => {
  const parsed = new URL(url);
  return `postgresql://${parsed.hostname || "localhost"}:${parsed.port || "5432"}/${parsed.pathname.slice(1)}`;
};

export const PgTriples = {
  /** `Triples` over a pooled PostgreSQL connection (migrations applied). */
  layer: (config: PostgresqlConfig) =>
    make(makePostgresqlLayer(config), scopeFromConfig(config), false),

  /** `Triples` from a connection URL, e.g. `postgresql://user:pw@host:5432/db`. */
  layerFromUrl: (url: string) => make(makePostgresqlLayerFromUrl(url), scopeFromUrl(url), false),

  /**
   * Build `Triples` from a host-provided ambient `SqlClient`. No pool is
   * created and no migration is run.
   */
  layerFromSqlClient: ({ scope }: PgTriplesFromSqlClientOptions) => fromSqlClient(scope, false),

  /** Explicitly migrate while building `Triples` from the ambient client. */
  layerFromSqlClientMigrated: ({ scope }: PgTriplesFromSqlClientOptions) =>
    fromSqlClient(scope, true),

  /**
   * Schema-bound pool plus `Triples` for a validated logical database. The
   * schema must already exist and migrations remain host-controlled.
   */
  layerForDatabase: (config: PostgresqlConfig, database: DatabaseId) =>
    make(makePostgresqlDatabaseSqlLayer(config, database), `database:${database}`, false),

  /** Explicit convenience variant that creates the schema and migrates it. */
  layerForDatabaseMigrated: (config: PostgresqlConfig, database: DatabaseId) =>
    make(makePostgresqlDatabaseSqlLayerMigrated(config, database), `database:${database}`, false),
} as const;

export type PgTriplesLayer = ReturnType<typeof PgTriples.layer>;
