/**
 * @triplex-build/triplex-sql
 *
 * SQL-bound database code: query executors, storage backends,
 * migrations, and layer implementations that depend on @effect/sql.
 */

// SQL schema, queries, and migrations
export {
  OPERATIONAL_ENTRIES_TABLE_DDL,
  OPERATIONAL_ENTRIES_POSTGRES_TABLE_DDL,
  OPERATIONAL_ENTRY_INDEX_DDLS,
  LIVE_PRECONDITION_INDEX_POSTGRES_DDL,
  TRANSACTION_ENTITY_PREFIX_INDEX_POSTGRES_DDL,
  TRIPLES_TABLE_DDL,
  MIGRATIONS_TABLE_DDL,
  COMMIT_POSITION_TABLE_DDL,
  COMMAND_RECEIPTS_TABLE_DDL,
  INDEX_DDLS,
  NUMERIC_VALUE_INDEX_DDL,
  SEALED_BLIND_INDEX_DDL,
  ENTITY_RECORDED_POSITION_INDEX_DDL,
  SEALED_VALUES_POSTGRES_DDLS,
  SEALED_VALUES_SQLITE_DDLS,
  INDEX_NAMES,
  ENTITY_BLOBS_TABLE_DDL,
  ENTITY_SNAPSHOTS_TABLE_DDL,
  SNAPSHOT_INDEX_DDLS,
  DATA_KEYS_TABLE_DDL,
  DATA_KEYS_ROOT_INDEX_DDL,
  KEY_ERASURES_TABLE_DDL,
  BLIND_KEYS_TABLE_DDL,
  KEY_STORE_DDLS,
} from "./schema.js";
export { packValue } from "./queries.js";
export { type Migration, migrations, runMigrations } from "./migrations.js";

// SQL-based query executors
export {
  SqlQueryExecutorLive,
  makeSqlQueryExecutor,
  makeSqlQueryExecutorLayer,
  type SqlStatementRunner,
} from "./SqlQueryExecutor.js";
export { SqlSnapshotsLive } from "./SqlSnapshots.js";
export {
  type SqlStorageAdapterService,
  type SqlDialect,
  SqliteDialect,
} from "@triplex-internal/core/internal";

// Storage backend
export { StorageBackend, type StorageBackendService } from "./StorageBackend.js";

// Database registry layer (SQL-backed)
export { DatabaseRegistryLive } from "./DatabaseRegistryLayer.js";

// Database manager layer (SQL-backed)
export { DatabaseManagerLive } from "./DatabaseManagerLayer.js";

export { makeSqlOperationalEntryStorage } from "./OperationalEntries.js";

export { makeSqlLivePreconditionLookup, makeSqlLiveFactsLookup } from "./LivePreconditions.js";

export { makeSqlTransactionPrefixLookup } from "./TransactionFeed.js";

// Reference key store: wrapped data and blind keys in the database's own SQL storage
export { SqlKeyStore, type SqlKeyStoreOptions } from "./KeyStore.js";
