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
import { SqlClient } from "effect/sql";
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
import { withPostgresqlTransaction } from "./TransactionConflict.js";

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
) =>
  fromSqlClient(scope, migrate).pipe(
    Layer.provideMerge(
      Layer.effect(SqlClient.SqlClient, SqlClient.SqlClient).pipe(Layer.provide(clientLayer)),
    ),
  );

const scopeFromConfig = (config: PostgresqlConfig): string =>
  `postgresql://${config.host ?? "localhost"}:${config.port ?? 5432}/${config.database}`;

const scopeFromUrl = (url: string): string => {
  const parsed = new URL(url);
  return `postgresql://${parsed.hostname || "localhost"}:${parsed.port || "5432"}/${parsed.pathname.slice(1)}`;
};

export const PgTriples = {
  /** Host-owned SQL transaction with typed serialization/deadlock conflicts; no automatic retry. */
  withTransaction: withPostgresqlTransaction,
  /** `Triples` over a pooled PostgreSQL connection (migrations applied). */
  layer: (config: PostgresqlConfig) =>
    fromSqlClient(scopeFromConfig(config), false).pipe(Layer.provide(makePostgresqlLayer(config))),

  /** `Triples` from a connection URL, e.g. `postgresql://user:pw@host:5432/db`. */
  layerFromUrl: (url: string) =>
    fromSqlClient(scopeFromUrl(url), false).pipe(Layer.provide(makePostgresqlLayerFromUrl(url))),

  /**
   * Build `Triples` from a host-provided ambient `SqlClient`. No pool is
   * created and no migration is run. Acquisition checks the installed schema
   * version and fails with `SchemaVersionError` if it differs from this release.
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
