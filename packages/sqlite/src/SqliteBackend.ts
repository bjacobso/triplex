/**
 * SQLite Storage Backend
 *
 * Each database gets its own SQLite database file.
 * The registry is stored in _registry.db.
 */

import { Config, Effect, Layer } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { FileSystem } from "effect";
import { SqliteDialect } from "@triplex-build/triplex/internal";
import type { DatabaseId } from "@triplex-build/triplex";
import { StorageBackend, type StorageBackendService } from "@triplex-build/triplex-sql";
import { SqliteAdapterLive } from "./SqliteAdapter.js";

// =============================================================================
// Configuration
// =============================================================================

export interface SqliteBackendConfig {
  /**
   * Directory to store database files.
   * Defaults to "./data"
   */
  readonly dataDir?: string;
}

// =============================================================================
// Implementation
// =============================================================================

const getDataDir = (config?: SqliteBackendConfig) =>
  config?.dataDir
    ? Effect.succeed(config.dataDir)
    : Config.string("DATA_DIR").pipe(Config.withDefault("./data"));

const databaseDbPath = (dataDir: string, database: DatabaseId): string =>
  `${dataDir}/${database}.db`;

const registryDbPath = (dataDir: string): string => `${dataDir}/_registry.db`;

/**
 * Create a SQLite storage backend layer.
 *
 * @example
 * ```typescript
 * const backend = SqliteBackend({ dataDir: "./data" })
 *
 * const app = DatabaseManagerLive.pipe(
 *   Layer.provide(backend)
 * )
 * ```
 */
export const makeSqliteBackend = (
  config?: SqliteBackendConfig,
): Layer.Layer<StorageBackend, never, FileSystem.FileSystem> =>
  Layer.effect(
    StorageBackend,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dataDir = yield* getDataDir(config);

      // Ensure data directory exists
      yield* fs.makeDirectory(dataDir, { recursive: true }).pipe(
        Effect.tapError((e) =>
          Effect.logWarning(`Failed to create data directory ${dataDir}: ${e}`),
        ),
        Effect.catch(() => Effect.void),
      );

      yield* Effect.logInfo(`Data directory initialized: ${dataDir}`);

      // Verify data directory is writable
      const testFilePath = `${dataDir}/.write-test`;
      yield* Effect.gen(function* () {
        yield* fs.writeFileString(testFilePath, "test");
        yield* fs.remove(testFilePath);
      }).pipe(
        Effect.catch((error) =>
          Effect.die(new Error(`Data directory ${dataDir} is not writable: ${error}`)),
        ),
      );

      const service: StorageBackendService = {
        dialect: SqliteDialect,

        createDatabaseClient: (database: DatabaseId) => {
          const dbPath = databaseDbPath(dataDir, database);
          return SqliteClient.layer({ filename: dbPath });
        },

        createAdapterLayer: (database: DatabaseId) => {
          const dbPath = databaseDbPath(dataDir, database);
          const sqlLayer = SqliteClient.layer({ filename: dbPath });
          return SqliteAdapterLive.pipe(Layer.provide(sqlLayer));
        },

        createRegistryClient: () => {
          return SqliteClient.layer({ filename: registryDbPath(dataDir) });
        },

        deleteDatabaseStorage: (database: DatabaseId) =>
          Effect.gen(function* () {
            const dbPath = databaseDbPath(dataDir, database);
            const walPath = `${dbPath}-wal`;
            const shmPath = `${dbPath}-shm`;

            yield* fs.remove(dbPath, { recursive: true }).pipe(Effect.ignore);
            yield* fs.remove(walPath).pipe(Effect.ignore);
            yield* fs.remove(shmPath).pipe(Effect.ignore);
          }),

        deleteAllStorage: () =>
          Effect.gen(function* () {
            // Read all files in the data directory
            const entries = yield* fs
              .readDirectory(dataDir)
              .pipe(Effect.catch(() => Effect.succeed([] as readonly string[])));

            // Delete all .db files and their associated -wal and -shm files
            for (const entry of entries) {
              if (entry.endsWith(".db") || entry.endsWith(".db-wal") || entry.endsWith(".db-shm")) {
                yield* fs.remove(`${dataDir}/${entry}`).pipe(Effect.ignore);
              }
            }
          }),

        getDatabaseSize: (database: DatabaseId) =>
          Effect.gen(function* () {
            const dbPath = databaseDbPath(dataDir, database);

            // Get the size of the main db file
            const dbSize = yield* fs.stat(dbPath).pipe(
              Effect.map((stat) => Number(stat.size)),
              Effect.catch(() => Effect.succeed(0)),
            );

            // Get the size of the WAL file if it exists
            const walPath = `${dbPath}-wal`;
            const walSize = yield* fs.stat(walPath).pipe(
              Effect.map((stat) => Number(stat.size)),
              Effect.catch(() => Effect.succeed(0)),
            );

            // Get the size of the SHM file if it exists
            const shmPath = `${dbPath}-shm`;
            const shmSize = yield* fs.stat(shmPath).pipe(
              Effect.map((stat) => Number(stat.size)),
              Effect.catch(() => Effect.succeed(0)),
            );

            return dbSize + walSize + shmSize;
          }),

        describe: () => `SQLite (${dataDir})`,
      };

      return service;
    }).pipe(Effect.orDie),
  );

/**
 * SQLite backend layer with default configuration.
 * Uses DATA_DIR from Effect ConfigProvider (defaults to "./data").
 */
export const SqliteBackendLive = makeSqliteBackend();
