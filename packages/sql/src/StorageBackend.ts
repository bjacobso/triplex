/**
 * StorageBackend service
 *
 * Abstracts over different SQL backends (SQLite, PostgreSQL, etc.)
 * allowing the deployment to control which storage driver to use.
 */

import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlDialect, StorageAdapter } from "@triplex-build/triplex/internal";
import type { DatabaseId } from "@triplex-build/triplex";

// =============================================================================
// Service Interface
// =============================================================================

/**
 * StorageBackend provides the ability to create SQL connections for databases.
 * Each database can have its own isolated storage (SQLite files) or
 * share a single database with schema isolation (PostgreSQL schemas).
 */
export interface StorageBackendService {
  /**
   * The SQL dialect for this backend (used by the Datalog compiler)
   */
  readonly dialect: SqlDialect;

  /**
   * Create a SQL client layer for a database.
   * For SQLite: Creates a new file-based database
   * For PostgreSQL: Uses the shared connection with database schema
   *
   * Note: The layer may have additional services in its output (e.g. PgClient)
   * and may have self-fulfilled requirements for initialization effects.
   */
  readonly createDatabaseClient: (
    database: DatabaseId,
  ) => Layer.Layer<SqlClient.SqlClient, unknown>;

  /**
   * Create a StorageAdapter layer for a database.
   * Composes the backend-specific adapter with the SQL client layer.
   * For SQLite: SqliteAdapterLive + SqliteClient
   * For PostgreSQL: PostgresqlAdapterLive + PgClient
   */
  readonly createAdapterLayer: (database: DatabaseId) => Layer.Layer<StorageAdapter, unknown>;

  /**
   * Create a SQL client layer for the registry database.
   * For SQLite: Creates _registry.db
   * For PostgreSQL: Uses public schema
   */
  readonly createRegistryClient: () => Layer.Layer<SqlClient.SqlClient, unknown>;

  /**
   * Delete a database's storage.
   * For SQLite: Removes the database file
   * For PostgreSQL: Drops the schema
   */
  readonly deleteDatabaseStorage: (database: DatabaseId) => Effect.Effect<void, unknown>;

  /**
   * Delete all storage including the registry.
   * For SQLite: Removes all database files in the data directory
   * For PostgreSQL: Drops all schemas
   */
  readonly deleteAllStorage: () => Effect.Effect<void, unknown>;

  /**
   * Get the size of a database's storage in bytes.
   * For SQLite: Returns the file size
   * For PostgreSQL: Returns the schema size
   */
  readonly getDatabaseSize: (database: DatabaseId) => Effect.Effect<number, unknown>;

  /**
   * Get the data directory (for SQLite) or connection info description
   */
  readonly describe: () => string;
}

// =============================================================================
// Service Tag
// =============================================================================

export class StorageBackend extends Context.Service<StorageBackend, StorageBackendService>()(
  "StorageBackend",
) {}
