/**
 * PostgreSQL Storage Backend
 *
 * Uses a single PostgreSQL database with schema-per-database isolation.
 * Each database gets its own PostgreSQL schema (e.g., "db_demo_hr").
 * The registry uses the "public" schema.
 */

import { Context, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { PgClient } from "@effect/sql-pg";
import { createHash } from "node:crypto";
import type { DatabaseId } from "@triplex-build/triplex";
import { type SqlDialect } from "@triplex-build/triplex/internal";
import {
  runMigrations,
  StorageBackend,
  type StorageBackendService,
} from "@triplex-build/triplex-sql";
import { PostgresqlDialect } from "./dialect.js";
import { PostgresqlAdapterLive } from "./PostgresqlAdapter.js";

// =============================================================================
// Configuration
// =============================================================================

export interface PostgresqlBackendConfig {
  readonly host?: string;
  readonly port?: number;
  readonly database: string;
  readonly username?: string;
  readonly password?: Redacted.Redacted<string>;
  readonly ssl?: boolean;
  readonly pool?: {
    readonly min?: number;
    readonly max?: number;
    readonly idleTimeout?: number;
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Convert a validated database ID to a bounded, deterministic schema name.
 * The readable prefix is never the uniqueness boundary; the digest prevents
 * collisions after normalization or truncation.
 */
export const databaseToSchema = (database: DatabaseId): string => {
  const slug = database.replace(/-/g, "_").slice(0, 32);
  const digest = createHash("sha256").update(database).digest("hex").slice(0, 16);
  return `triplex_${slug}_${digest}`;
};

const quoteIdentifier = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

const connectionUrl = (config: PostgresqlBackendConfig, schema?: string): string => {
  const username = encodeURIComponent(config.username ?? "postgres");
  const password = config.password ? `:${encodeURIComponent(Redacted.value(config.password))}` : "";
  const host = config.host ?? "localhost";
  const port = config.port ?? 5432;
  const url = new URL(
    `postgresql://${username}${password}@${host}:${port}/${encodeURIComponent(config.database)}`,
  );
  if (schema !== undefined) {
    // libpq startup options are applied independently to every pooled
    // connection, unlike a one-time SET executed on an arbitrary checkout.
    url.searchParams.set("options", `-c search_path=${schema},pg_catalog`);
  }
  if (config.ssl) url.searchParams.set("sslmode", "require");
  return url.toString();
};

/**
 * Create the base PgClient layer from config
 */
const createBaseLayer = (config: PostgresqlBackendConfig) =>
  PgClient.layer({
    ...(config.host && { host: config.host }),
    ...(config.port && { port: config.port }),
    database: config.database,
    ...(config.username && { username: config.username }),
    ...(config.password && { password: config.password }),
    ...(config.ssl !== undefined && { ssl: config.ssl }),
    ...(config.pool?.min !== undefined && { minConnections: config.pool.min }),
    ...(config.pool?.max !== undefined && { maxConnections: config.pool.max }),
    ...(config.pool?.idleTimeout !== undefined && { idleTimeout: config.pool.idleTimeout }),
  });

/**
 * A one-time session-local `SET search_path` cannot safely initialize a pool:
 * setup may run on a different checkout from a later query. Supplying the
 * setting in PostgreSQL startup options binds every physical connection in the
 * scoped pool before it can execute application SQL.
 */
const createScopedPoolLayer = (config: PostgresqlBackendConfig, schema: string) =>
  PgClient.layer({
    url: Redacted.make(connectionUrl(config, schema)),
    ...(config.pool?.min !== undefined && { minConnections: config.pool.min }),
    ...(config.pool?.max !== undefined && { maxConnections: config.pool.max }),
    ...(config.pool?.idleTimeout !== undefined && { idleTimeout: config.pool.idleTimeout }),
  });

const createSchemaLayer = (config: PostgresqlBackendConfig, schema: string) =>
  createScopedPoolLayer(config, schema).pipe(
    Layer.tap((ctx) =>
      Effect.gen(function* () {
        const sql = Context.get(ctx, SqlClient.SqlClient);
        // A composed database layer may initialize an adapter pool and a query
        // pool for the same new schema concurrently. PostgreSQL's `IF NOT
        // EXISTS` check can still race at the namespace unique index, so lock
        // this deterministic schema identity through creation.
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${schema}, 0))`;
            yield* sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
          }),
        );
      }),
    ),
  );

/**
 * A pool whose every physical connection is bound to one validated Triplex
 * database schema. This does not create the schema or run migrations.
 */
export const makePostgresqlDatabaseSqlLayer = (
  config: PostgresqlBackendConfig,
  database: DatabaseId,
) => createScopedPoolLayer(config, databaseToSchema(database));

/**
 * Explicit convenience provisioning for demos and tests: create the schema
 * and run the exported Triplex SQL migrations before exposing its client.
 */
export const makePostgresqlDatabaseSqlLayerMigrated = (
  config: PostgresqlBackendConfig,
  database: DatabaseId,
) => {
  const schema = databaseToSchema(database);
  return createSchemaLayer(config, schema).pipe(
    Layer.tap((context) => Effect.provide(runMigrations, context)),
  );
};

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a PostgreSQL storage backend layer.
 *
 * @example
 * ```typescript
 * const backend = makePostgresqlBackend({
 *   host: "localhost",
 *   database: "ontology",
 *   username: "app",
 *   password: Redacted.make("secret")
 * })
 *
 * const app = DatabaseManagerLive.pipe(
 *   Layer.provide(backend)
 * )
 * ```
 */
export const makePostgresqlBackend = (
  config: PostgresqlBackendConfig,
): Layer.Layer<StorageBackend> =>
  Layer.succeed(StorageBackend, {
    dialect: PostgresqlDialect as SqlDialect,

    createDatabaseClient: (database: DatabaseId) => {
      const schema = databaseToSchema(database);
      return createSchemaLayer(config, schema);
    },

    createAdapterLayer: (database: DatabaseId) => {
      const schema = databaseToSchema(database);
      const sqlLayer = createSchemaLayer(config, schema);
      return PostgresqlAdapterLive.pipe(Layer.provide(sqlLayer));
    },

    createRegistryClient: () => {
      return createScopedPoolLayer(config, "public");
    },

    deleteDatabaseStorage: (database: DatabaseId) =>
      Effect.gen(function* () {
        const schema = databaseToSchema(database);
        // Need a client to delete - use scoped execution
        const layer = createBaseLayer(config);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
          }).pipe(Effect.provide(layer)),
        );
      }),

    deleteAllStorage: () =>
      Effect.gen(function* () {
        const layer = createBaseLayer(config);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            // Only deterministic Triplex-owned schemas are eligible.
            const schemas = yield* sql<{ schema_name: string }>`
              SELECT schema_name
              FROM information_schema.schemata
              WHERE schema_name LIKE 'triplex_%'
            `;
            // Drop each schema
            for (const { schema_name } of schemas) {
              yield* sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema_name)} CASCADE`);
            }
            // Also clear Triplex's registry tables in the public schema.
            yield* sql.unsafe(`DROP TABLE IF EXISTS public.database_access`);
            yield* sql.unsafe(`DROP TABLE IF EXISTS public.databases`);
          }).pipe(Effect.provide(layer)),
        );
      }),

    getDatabaseSize: (database: DatabaseId) =>
      Effect.gen(function* () {
        const schema = databaseToSchema(database);
        const layer = createBaseLayer(config);
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            // Get total size of all tables in the schema
            const result = yield* sql<{ total_bytes: bigint }>`
              SELECT COALESCE(SUM(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename))), 0) AS total_bytes
              FROM pg_tables
              WHERE schemaname = ${schema}
            `;
            const row = result[0];
            return row ? Number(row.total_bytes) : 0;
          }).pipe(Effect.provide(layer)),
        );
      }),

    describe: () =>
      `PostgreSQL (${config.host ?? "localhost"}:${config.port ?? 5432}/${config.database})`,
  } satisfies StorageBackendService);

/**
 * Create PostgreSQL backend from a connection URL.
 *
 * @example
 * ```typescript
 * const backend = makePostgresqlBackendFromUrl(
 *   "postgresql://user:pass@localhost:5432/ontology"
 * )
 * ```
 */
export const makePostgresqlBackendFromUrl = (url: string): Layer.Layer<StorageBackend> => {
  const parsed = new URL(url);

  return makePostgresqlBackend({
    database: parsed.pathname.slice(1),
    ...(parsed.hostname && { host: parsed.hostname }),
    ...(parsed.port && { port: parseInt(parsed.port, 10) }),
    ...(parsed.username && { username: parsed.username }),
    ...(parsed.password && { password: Redacted.make(parsed.password) }),
    ssl: parsed.searchParams.get("ssl") === "true",
  });
};
