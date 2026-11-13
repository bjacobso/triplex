import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { migrations, runMigrations, SchemaVersionError } from "@triplex-build/triplex-sql";

const configureSqlite = (layer: ReturnType<typeof SqliteClient.layer>, migrate: boolean) =>
  layer.pipe(
    Layer.tap((context) =>
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // Enable WAL mode for concurrent reads
          yield* sql`PRAGMA journal_mode = WAL`;
          // Normal sync is safe with WAL and faster
          yield* sql`PRAGMA synchronous = NORMAL`;
          // 64MB cache
          yield* sql`PRAGMA cache_size = -64000`;
          // Store temp tables in memory
          yield* sql`PRAGMA temp_store = MEMORY`;
          if (migrate) yield* runMigrations;
        }),
        context,
      ),
    ),
  );

// Create SQLite layer with WAL mode for better concurrent read performance
export const makeSqliteLayer = (filename: string) =>
  configureSqlite(SqliteClient.layer({ filename }), true);

/** SQL client only; the production host must execute `runMigrations`. */
export const makeSqliteLayerUnmigrated = (filename: string) =>
  configureSqlite(SqliteClient.layer({ filename }), false);

// In-memory SQLite for testing
export const SqliteTestLayer = SqliteClient.layer({ filename: ":memory:" }).pipe(
  Layer.tap((context) => Effect.provide(runMigrations, context)),
);

// Production layer factory
export const SqliteLive = (filename: string) => makeSqliteLayer(filename);

/**
 * A read-only SQL client for an existing, migrated file. The file is opened
 * read-only and with `query_only`, no migration runs, and acquisition fails
 * with `SchemaVersionError` unless the file is at exactly this release's
 * schema version. `actualVersion` is zero for a file with no Triplex schema.
 */
export const makeSqliteLayerReadOnly = (filename: string) =>
  SqliteClient.layer({ filename, readonly: true, disableWAL: true }).pipe(
    Layer.tap((context) =>
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA query_only = ON`;
          const expectedVersion = Math.max(...migrations.map((migration) => migration.version));
          const [history] = yield* sql<{ readonly found: number }>`
            SELECT COUNT(*) AS found FROM sqlite_master
            WHERE type = 'table' AND name = 'triplex_schema_migrations'
          `;
          let actualVersion = 0;
          if (Number(history?.found ?? 0) > 0) {
            const [row] = yield* sql<{ readonly version: number | null }>`
              SELECT MAX(version) AS version FROM triplex_schema_migrations
            `;
            actualVersion = Number(row?.version ?? 0);
          }
          if (actualVersion !== expectedVersion) {
            return yield* new SchemaVersionError({ expectedVersion, actualVersion });
          }
        }),
        context,
      ),
    ),
  );
