/**
 * DatabaseRegistry layer implementation for Node.js
 *
 * Uses SQLite for registry storage via the StorageBackend.
 */

import { Effect, Layer, Scope, Context, pipe, Exit } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  DatabaseRegistry,
  type DatabaseRegistryService,
  type DatabaseAccessEntry,
  type Database,
  DatabaseNotFound,
  DatabaseAlreadyExists,
  InternalError,
  RuntimeClock,
} from "@triplex-build/triplex/internal";
import { StorageBackend } from "./StorageBackend.js";

// =============================================================================
// Registry Schema
// =============================================================================

interface DatabaseRow {
  name: string;
  description: string | null;
  created_at: number;
}

interface AccessRow {
  user_id: string;
  database_name: string;
  role: string;
  created_at: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Map any error to InternalError
 */
const mapToInternalError = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, InternalError, R> =>
  pipe(
    effect,
    Effect.mapError((e) => new InternalError({ message: String(e) })),
  );

/**
 * Create the registry tables if they don't exist
 */
const initRegistry = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`
      CREATE TABLE IF NOT EXISTS databases (
        name TEXT PRIMARY KEY,
        description TEXT,
        created_at BIGINT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS database_access (
        user_id TEXT NOT NULL,
        database_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'owner',
        created_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, database_name),
        FOREIGN KEY (database_name) REFERENCES databases(name) ON DELETE CASCADE
      )
    `;
  });

const toAccessEntry = (row: AccessRow): DatabaseAccessEntry => ({
  userId: row.user_id,
  databaseName: row.database_name,
  role: row.role as "owner" | "member",
  createdAt: Number(row.created_at),
});

// =============================================================================
// Layer Implementation
// =============================================================================

/**
 * DatabaseRegistryLive layer
 *
 * Provides the DatabaseRegistry service using SQLite storage.
 * Requires StorageBackend for database operations.
 */
export const DatabaseRegistryLive = Layer.effect(
  DatabaseRegistry,
  Effect.gen(function* () {
    const backend = yield* StorageBackend;
    const clock = yield* RuntimeClock;
    const now = () => Effect.runSync(clock.now);

    // Initialize registry database with its own persistent scope
    const registryScope = yield* Scope.make();
    const registryLayer = backend.createRegistryClient();
    const registryContext = yield* Layer.buildWithScope(registryLayer, registryScope).pipe(
      mapToInternalError,
    );
    const registrySql = Context.get(registryContext, SqlClient.SqlClient);

    // SQLite disables foreign keys by default. PostgreSQL enforces them and
    // does not accept the SQLite-only PRAGMA syntax.
    if (backend.dialect.name === "sqlite") {
      yield* pipe(registrySql`PRAGMA foreign_keys = ON`, mapToInternalError);
    }

    yield* initRegistry(registrySql);
    yield* Effect.logInfo("Registry database initialized");

    // =========================================================================
    // Database Metadata
    // =========================================================================

    const list = (): Effect.Effect<readonly Database[], InternalError> =>
      Effect.gen(function* () {
        const rows = yield* pipe(
          registrySql<DatabaseRow>`SELECT * FROM databases ORDER BY name`,
          mapToInternalError,
        );

        return rows.map((row) => ({
          name: row.name,
          description: row.description,
          createdAt: Number(row.created_at),
        }));
      });

    const register = (
      name: string,
      description?: string,
    ): Effect.Effect<Database, DatabaseAlreadyExists | InternalError> =>
      Effect.gen(function* () {
        // Check if already exists
        const existing = yield* pipe(
          registrySql<DatabaseRow>`SELECT * FROM databases WHERE name = ${name}`,
          mapToInternalError,
        );

        if (existing.length > 0) {
          return yield* Effect.fail(new DatabaseAlreadyExists({ database: name }));
        }

        const createdAt = now();

        // Create database entry in registry
        yield* pipe(
          registrySql`
            INSERT INTO databases (name, description, created_at)
            VALUES (${name}, ${description ?? null}, ${createdAt})
          `,
          mapToInternalError,
        );

        yield* Effect.logInfo(`Database registered: ${name}`);

        return {
          name,
          description: description ?? null,
          createdAt,
        } satisfies Database;
      });

    const unregister = (name: string): Effect.Effect<void, DatabaseNotFound | InternalError> =>
      Effect.gen(function* () {
        // Check if exists
        const existing = yield* pipe(
          registrySql<DatabaseRow>`SELECT * FROM databases WHERE name = ${name}`,
          mapToInternalError,
        );

        if (existing.length === 0) {
          return yield* Effect.fail(new DatabaseNotFound({ database: name }));
        }

        // Delete from registry (cascade deletes access entries)
        yield* pipe(registrySql`DELETE FROM databases WHERE name = ${name}`, mapToInternalError);

        yield* Effect.logInfo(`Database unregistered: ${name}`);
      });

    const get = (name: string): Effect.Effect<Database, DatabaseNotFound | InternalError> =>
      Effect.gen(function* () {
        const rows = yield* pipe(
          registrySql<DatabaseRow>`SELECT * FROM databases WHERE name = ${name}`,
          mapToInternalError,
        );

        if (rows.length === 0) {
          return yield* Effect.fail(new DatabaseNotFound({ database: name }));
        }

        const row = rows[0]!;

        return {
          name: row.name,
          description: row.description,
          createdAt: Number(row.created_at),
        } satisfies Database;
      });

    const update = (
      name: string,
      fields: { description?: string },
    ): Effect.Effect<Database, DatabaseNotFound | InternalError> =>
      Effect.gen(function* () {
        // Check if exists
        const existing = yield* pipe(
          registrySql<DatabaseRow>`SELECT * FROM databases WHERE name = ${name}`,
          mapToInternalError,
        );

        if (existing.length === 0) {
          return yield* Effect.fail(new DatabaseNotFound({ database: name }));
        }

        if (fields.description !== undefined) {
          yield* pipe(
            registrySql`UPDATE databases SET description = ${fields.description} WHERE name = ${name}`,
            mapToInternalError,
          );
        }

        return yield* get(name);
      });

    /**
     * Clear all registered databases from the registry.
     *
     * NOTE: This only clears the registry metadata (database names, descriptions,
     * timestamps). It does NOT delete the actual database storage files.
     * To fully delete databases, use DatabaseManager.delete() or deleteAll().
     */
    const clear = (): Effect.Effect<void, InternalError> =>
      Effect.gen(function* () {
        yield* pipe(registrySql`DELETE FROM database_access`, mapToInternalError);
        yield* pipe(registrySql`DELETE FROM databases`, mapToInternalError);
        yield* Effect.logInfo("Registry cleared");
      });

    // =========================================================================
    // Access Control
    // =========================================================================

    const grantAccess = (
      userId: string,
      databaseName: string,
      role: "owner" | "member",
    ): Effect.Effect<DatabaseAccessEntry, DatabaseNotFound | InternalError> =>
      Effect.gen(function* () {
        // Verify database exists
        yield* get(databaseName);

        const createdAt = now();
        yield* pipe(
          registrySql`
            INSERT INTO database_access (user_id, database_name, role, created_at)
            VALUES (${userId}, ${databaseName}, ${role}, ${createdAt})
            ON CONFLICT (user_id, database_name) DO UPDATE SET role = ${role}, created_at = ${createdAt}
          `,
          mapToInternalError,
        );

        return { userId, databaseName, role, createdAt };
      });

    const revokeAccess = (
      userId: string,
      databaseName: string,
    ): Effect.Effect<void, DatabaseNotFound | InternalError> =>
      Effect.gen(function* () {
        yield* get(databaseName);
        yield* pipe(
          registrySql`
            DELETE FROM database_access
            WHERE user_id = ${userId} AND database_name = ${databaseName}
          `,
          mapToInternalError,
        );
      });

    const listAccess = (
      databaseName: string,
    ): Effect.Effect<readonly DatabaseAccessEntry[], DatabaseNotFound | InternalError> =>
      Effect.gen(function* () {
        yield* get(databaseName);
        const rows = yield* pipe(
          registrySql<AccessRow>`
            SELECT * FROM database_access WHERE database_name = ${databaseName}
          `,
          mapToInternalError,
        );
        return rows.map(toAccessEntry);
      });

    const listUserDatabases = (
      userId: string,
    ): Effect.Effect<readonly DatabaseAccessEntry[], InternalError> =>
      Effect.gen(function* () {
        const rows = yield* pipe(
          registrySql<AccessRow>`
            SELECT * FROM database_access WHERE user_id = ${userId}
          `,
          mapToInternalError,
        );
        return rows.map(toAccessEntry);
      });

    const hasAccess = (
      userId: string,
      databaseName: string,
    ): Effect.Effect<boolean, InternalError> =>
      Effect.gen(function* () {
        const userRows = yield* pipe(
          registrySql<{ cnt: number }>`
            SELECT COUNT(*) as cnt FROM database_access
            WHERE user_id = ${userId} AND database_name = ${databaseName}
          `,
          mapToInternalError,
        );
        return (userRows[0]?.cnt ?? 0) > 0;
      });

    // Clean up registry scope when the service is closed
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Scope.close(registryScope, Exit.void).pipe(Effect.catch(() => Effect.void));
        yield* Effect.logInfo("Registry database connection closed");
      }),
    );

    return {
      list,
      register,
      unregister,
      get,
      update,
      clear,
      grantAccess,
      revokeAccess,
      listAccess,
      listUserDatabases,
      hasAccess,
    } satisfies DatabaseRegistryService;
  }),
);
