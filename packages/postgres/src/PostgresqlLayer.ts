import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { runMigrations } from "@triplex-build/triplex-sql";

/**
 * PostgreSQL connection configuration.
 */
export interface PostgresqlConfig {
  readonly host?: string;
  readonly port?: number;
  readonly database: string;
  readonly username?: string;
  readonly password?: Redacted.Redacted<string>;
  readonly ssl?: boolean;
  /** Connection pool configuration */
  readonly pool?: {
    readonly min?: number;
    readonly max?: number;
    readonly idleTimeout?: number;
  };
}

const clientLayer = (config: PostgresqlConfig) =>
  PgClient.layer({
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
    password: config.password,
    ssl: config.ssl,
    minConnections: config.pool?.min,
    maxConnections: config.pool?.max,
    idleTimeout: config.pool?.idleTimeout,
  });

/**
 * Create PostgreSQL layer with connection pooling and migrations.
 *
 * Uses Layer.tap to run migrations after the PgClient layer is built.
 * The tap callback receives the built context and provides SqlClient
 * to runMigrations so it doesn't leak as an unsatisfied requirement.
 */
export const makePostgresqlLayer = (config: PostgresqlConfig) =>
  clientLayer(config).pipe(Layer.tap((context) => Effect.provide(runMigrations, context)));

/** SQL client only; the production host must execute `runMigrations`. */
export const makePostgresqlLayerUnmigrated = (config: PostgresqlConfig) => clientLayer(config);

/**
 * Create PostgreSQL layer from a connection URL.
 *
 * Example: postgresql://user:password@localhost:5432/dbname
 */
export const makePostgresqlLayerFromUrl = (url: string) => {
  const parsed = new URL(url);
  return makePostgresqlLayer({
    database: parsed.pathname.slice(1),
    ...(parsed.hostname && { host: parsed.hostname }),
    ...(parsed.port && { port: parseInt(parsed.port, 10) }),
    ...(parsed.username && { username: parsed.username }),
    ...(parsed.password && { password: Redacted.make(parsed.password) }),
    ...(parsed.searchParams.get("ssl") === "true" && { ssl: true }),
  });
};

export const makePostgresqlLayerUnmigratedFromUrl = (url: string) => {
  const parsed = new URL(url);
  return makePostgresqlLayerUnmigrated({
    database: parsed.pathname.slice(1),
    ...(parsed.hostname && { host: parsed.hostname }),
    ...(parsed.port && { port: parseInt(parsed.port, 10) }),
    ...(parsed.username && { username: parsed.username }),
    ...(parsed.password && { password: Redacted.make(parsed.password) }),
    ...(parsed.searchParams.get("ssl") === "true" && { ssl: true }),
  });
};

/**
 * PostgreSQL layer factory for production use.
 */
export const PostgresqlLive = makePostgresqlLayer;

/**
 * PostgreSQL layer factory from connection URL.
 */
export const PostgresqlLiveFromUrl = makePostgresqlLayerFromUrl;
