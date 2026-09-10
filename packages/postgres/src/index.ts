/**
 * PostgreSQL backend package for @triplex-build/triplex.
 *
 * Provides PostgreSQL-specific storage adapter, backend, and connection layer.
 */

export { PostgresqlDialect } from "./dialect.js";
export {
  makePostgresqlAdapter,
  PostgresqlAdapterLive,
  PostgresqlAdapterUnmigrated,
  type PostgresqlAdapterConfig,
} from "./PostgresqlAdapter.js";
export {
  makePostgresqlBackend,
  makePostgresqlBackendFromUrl,
  makePostgresqlDatabaseSqlLayer,
  makePostgresqlDatabaseSqlLayerMigrated,
  databaseToSchema,
  type PostgresqlBackendConfig,
} from "./PostgresqlBackend.js";
export {
  makePostgresqlLayer,
  makePostgresqlLayerFromUrl,
  makePostgresqlLayerUnmigrated,
  makePostgresqlLayerUnmigratedFromUrl,
  PostgresqlLive,
  PostgresqlLiveFromUrl,
  type PostgresqlConfig,
} from "./PostgresqlLayer.js";
export { PgTriples, type PgTriplesLayer, type PgTriplesFromSqlClientOptions } from "./PgTriples.js";
