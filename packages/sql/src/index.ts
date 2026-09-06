/**
 * @bjacobso/triplex-sql
 *
 * SQL-bound database code: query executors, storage backends,
 * migrations, and layer implementations that depend on @effect/sql.
 */

// SQL schema, queries, and migrations
export {
  TRIPLES_TABLE_DDL,
  MIGRATIONS_TABLE_DDL,
  COMMIT_POSITION_TABLE_DDL,
  COMMAND_RECEIPTS_TABLE_DDL,
  INDEX_DDLS,
  INDEX_NAMES,
  ENTITY_BLOBS_TABLE_DDL,
  ENTITY_SNAPSHOTS_TABLE_DDL,
  SNAPSHOT_INDEX_DDLS,
} from "./schema.js";
export { packValue } from "./queries.js";
export { type Migration, migrations, runMigrations } from "./migrations.js";

// SQL-based query executors
export {
  SqlQueryExecutorLive,
  makeSqlQueryExecutor,
  type SqlStatementRunner,
} from "./SqlQueryExecutor.js";

// Storage backend
export { StorageBackend, type StorageBackendService } from "./StorageBackend.js";

// Database registry layer (SQL-backed)
export { DatabaseRegistryLive } from "./DatabaseRegistryLayer.js";

// Database manager layer (SQL-backed)
export { DatabaseManagerLive } from "./DatabaseManagerLayer.js";
