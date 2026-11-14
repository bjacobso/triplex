import { resolve } from "node:path";
import { Effect, Layer, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { checkSchema, runMigrations } from "@triplex-build/triplex-sql";

/**
 * One setup at a time per database file in this process.
 *
 * The SQLite driver is synchronous: a connection that meets a lock waits for
 * its busy timeout by blocking the only JavaScript thread. When two
 * connections in one process open a new file at once, the first holds the
 * write lock of its schema transaction across an Effect yield, the second
 * blocks the thread waiting for it, the first can never resume, and the second
 * fails with `LockTimeoutError` ("database is locked") after the timeout.
 * Setup (switching to WAL and migrating) is therefore serialized per file; the
 * second opener then finds the schema current and only reads it. Separate
 * processes are unaffected: there the busy wait lets the holder finish.
 */
const setupLocks = new Map<string, Semaphore.Semaphore>();
const setupLock = (filename: string): Semaphore.Semaphore | undefined => {
  // Each in-memory connection is its own database.
  if (filename === ":memory:" || filename === "" || filename.startsWith("file::memory:"))
    return undefined;
  const key = resolve(filename);
  let lock = setupLocks.get(key);
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    setupLocks.set(key, lock);
  }
  return lock;
};

const configureSqlite = (filename: string, migrate: boolean) =>
  SqliteClient.layer({ filename }).pipe(
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
        }).pipe((setup) => setupLock(filename)?.withPermits(1)(setup) ?? setup),
        context,
      ),
    ),
  );

// Create SQLite layer with WAL mode for better concurrent read performance
export const makeSqliteLayer = (filename: string) => configureSqlite(filename, true);

/** SQL client only; the production host must execute `runMigrations`. */
export const makeSqliteLayerUnmigrated = (filename: string) => configureSqlite(filename, false);

// In-memory SQLite for testing
export const SqliteTestLayer = SqliteClient.layer({ filename: ":memory:" }).pipe(
  Layer.tap((context) => Effect.provide(runMigrations, context)),
);

// Production layer factory
export const SqliteLive = (filename: string) => makeSqliteLayer(filename);

/**
 * A read-only SQL client for an existing, migrated file. The file is opened
 * read-only and with `query_only`, no migration runs, and acquisition fails
 * with `SchemaVersionError` unless the file has exactly this release's
 * schema. `actualVersion` is zero for a file with no Triplex schema; a file
 * written by Triplex 0.4 or earlier is refused.
 */
export const makeSqliteLayerReadOnly = (filename: string) =>
  SqliteClient.layer({ filename, readonly: true, disableWAL: true }).pipe(
    Layer.tap((context) =>
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA query_only = ON`;
          yield* checkSchema({ allowEmpty: false });
        }),
        context,
      ),
    ),
  );
