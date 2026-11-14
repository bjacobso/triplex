import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { MigrationError } from "@triplex-internal/core/internal";
import {
  PUBLIC_READ_INDEX_DDLS,
  INTERVAL_HISTORY_INDEX_DDLS,
  LIVE_PRECONDITION_INDEX_POSTGRES_DDL,
  TRIPLES_TABLE_DDL,
  BASELINE_INDEX_DDLS,
  NUMERIC_VALUE_INDEX_DDL,
  SEALED_BLIND_INDEX_DDL,
  ENTITY_RECORDED_POSITION_INDEX_DDL,
  ENTITY_BLOBS_TABLE_DDL,
  ENTITY_SNAPSHOTS_TABLE_DDL,
  SNAPSHOT_INDEX_DDLS,
  OPERATIONAL_ENTRIES_TABLE_DDL,
  OPERATIONAL_ENTRY_INDEX_DDLS,
  OPERATIONAL_ENTRIES_POSTGRES_TABLE_DDL,
  COMMIT_POSITION_TABLE_DDL,
  KEY_STORE_DDLS,
  JOURNAL_DDLS,
  TRANSACTION_ENTITIES_POSTGRES_TABLE_DDL,
} from "./schema.js";
import { SchemaVersionError } from "./SchemaVersion.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  /**
   * Dialect-specific statements, run before `up` on the matching dialect.
   * Hosts that execute migrations themselves must run the statements for
   * their dialect, then `up`.
   */
  readonly dialects?: {
    readonly sqlite?: ReadonlyArray<string>;
    readonly pg?: ReadonlyArray<string>;
  };
  /** Portable statements run on every dialect. */
  readonly up: ReadonlyArray<string>;
}

/**
 * The name of the one migration this release applies. Databases written by
 * Triplex 0.4 or earlier record a different history (a `triplex_baseline` v1
 * plus later versions); this release refuses them rather than migrating.
 */
export const BASELINE_MIGRATION_NAME = "triplex_journal_store_baseline";

/**
 * The Triplex schema: one baseline that creates the current layout directly.
 *
 * DDL is imported from schema.ts so explicit host-owned migration execution and
 * convenience auto-migration use the same definitions. PostgreSQL creates its
 * bytewise-ordered tables first, so the portable `IF NOT EXISTS` statements
 * leave them alone.
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: BASELINE_MIGRATION_NAME,
    dialects: {
      pg: [
        OPERATIONAL_ENTRIES_POSTGRES_TABLE_DDL,
        TRANSACTION_ENTITIES_POSTGRES_TABLE_DDL,
        TRIPLES_TABLE_DDL,
        LIVE_PRECONDITION_INDEX_POSTGRES_DDL,
      ],
    },
    up: [
      TRIPLES_TABLE_DDL,
      ...PUBLIC_READ_INDEX_DDLS,
      ...BASELINE_INDEX_DDLS,
      NUMERIC_VALUE_INDEX_DDL,
      SEALED_BLIND_INDEX_DDL,
      ENTITY_RECORDED_POSITION_INDEX_DDL,
      ...INTERVAL_HISTORY_INDEX_DDLS,
      COMMIT_POSITION_TABLE_DDL,
      ...JOURNAL_DDLS,
      ENTITY_BLOBS_TABLE_DDL,
      ENTITY_SNAPSHOTS_TABLE_DDL,
      ...SNAPSHOT_INDEX_DDLS,
      OPERATIONAL_ENTRIES_TABLE_DDL,
      ...OPERATIONAL_ENTRY_INDEX_DDLS,
      ...KEY_STORE_DDLS,
    ],
  },
];

/** The schema version this release requires. */
export const SCHEMA_VERSION = Math.max(...migrations.map((migration) => migration.version));

export interface SchemaHistoryRow {
  readonly version: number;
  readonly name: string;
}

/**
 * Compare a database's recorded schema history with this release's. Returns
 * `"empty"` for a database with no history, `"current"` for exactly this
 * release's baseline, and a `SchemaVersionError` for anything else, including
 * every database written by Triplex 0.4 or earlier.
 */
export const checkSchemaHistory = (
  history: ReadonlyArray<SchemaHistoryRow>,
): "empty" | "current" | SchemaVersionError => {
  if (history.length === 0) return "empty";
  const rows = [...history].sort((a, b) => Number(a.version) - Number(b.version));
  const matches =
    rows.length === migrations.length &&
    rows.every(
      (row, index) =>
        Number(row.version) === migrations[index]!.version && row.name === migrations[index]!.name,
    );
  return matches
    ? "current"
    : new SchemaVersionError({
        expectedVersion: SCHEMA_VERSION,
        actualVersion: Math.max(...rows.map((row) => Number(row.version))),
        actualName: rows.at(-1)!.name,
      });
};

/**
 * Read-only preflight of the current schema's migration history. It never
 * queries a missing table, which would abort a caller's ambient PostgreSQL
 * transaction, and on PostgreSQL it checks the current schema explicitly so a
 * table in a fallback search-path schema cannot make a database look ready.
 */
export const readSchemaHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const exists = yield* sql.onDialectOrElse({
    pg: () =>
      sql<{ readonly relation: string | null }>`
        SELECT to_regclass(quote_ident(current_schema()) || '.triplex_schema_migrations')::text AS relation
      `.pipe(Effect.map(([row]) => row?.relation != null)),
    orElse: () =>
      sql<{ readonly found: number }>`
        SELECT COUNT(*) AS found FROM sqlite_master
        WHERE type = 'table' AND name = 'triplex_schema_migrations'
      `.pipe(Effect.map(([row]) => Number(row?.found ?? 0) > 0)),
  });
  if (!exists) return [] as ReadonlyArray<SchemaHistoryRow>;
  return yield* sql<SchemaHistoryRow>`
    SELECT version, name FROM triplex_schema_migrations ORDER BY version
  `;
});

/**
 * Fail with `SchemaVersionError` unless the database has this release's schema,
 * or (when `allowEmpty`) no Triplex schema yet. Every layer, migrating or not,
 * runs this before touching the database, so a 0.4 database is refused rather
 * than half-upgraded.
 */
export const checkSchema = (options: { readonly allowEmpty: boolean }) =>
  readSchemaHistory.pipe(
    Effect.flatMap((history) => {
      const status = checkSchemaHistory(history);
      if (status === "current" || (status === "empty" && options.allowEmpty)) return Effect.void;
      return Effect.fail(
        status === "empty"
          ? new SchemaVersionError({ expectedVersion: SCHEMA_VERSION, actualVersion: 0 })
          : status,
      );
    }),
  );

export const runMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const status = checkSchemaHistory(yield* readSchemaHistory);
  if (status === "current") return;
  if (status !== "empty") return yield* status;

  yield* sql`
    CREATE TABLE IF NOT EXISTS triplex_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at BIGINT NOT NULL
    )
  `;

  for (const migration of migrations) {
    const dialectStatements = sql.onDialectOrElse({
      orElse: () => [] as ReadonlyArray<string>,
      sqlite: () => migration.dialects?.sqlite ?? [],
      pg: () => migration.dialects?.pg ?? [],
    });

    // Each migration (and its applied record) commits atomically.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const statement of [...dialectStatements, ...migration.up]) {
          yield* sql.unsafe(statement).pipe(
            Effect.mapError(
              (error) =>
                new MigrationError({
                  version: migration.version,
                  name: migration.name,
                  message: `Failed to run migration: ${String(error)}`,
                  cause: error,
                }),
            ),
          );
        }

        // Record migration as applied
        const now = Date.now();
        yield* sql`
          INSERT INTO triplex_schema_migrations (version, name, applied_at)
          VALUES (${migration.version}, ${migration.name}, ${now})
        `;
      }),
    );
  }
});
