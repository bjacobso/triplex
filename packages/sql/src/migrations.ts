import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { MigrationError } from "@triplex-build/triplex/internal";
import {
  INTERVAL_HISTORY_INDEX_DDLS,
  LIVE_PRECONDITION_INDEX_POSTGRES_DDL,
  TRANSACTION_ENTITY_PREFIX_INDEX_POSTGRES_DDL,
  TRIPLES_TABLE_DDL,
  BASELINE_INDEX_DDLS,
  NUMERIC_VALUE_INDEX_DDL,
  SEALED_BLIND_INDEX_DDL,
  SEALED_VALUES_POSTGRES_DDLS,
  SEALED_VALUES_SQLITE_DDLS,
  ENTITY_RECORDED_POSITION_INDEX_DDL,
  ENTITY_BLOBS_TABLE_DDL,
  ENTITY_SNAPSHOTS_TABLE_DDL,
  SNAPSHOT_INDEX_DDLS,
  OPERATIONAL_ENTRIES_TABLE_DDL,
  OPERATIONAL_ENTRY_INDEX_DDLS,
  OPERATIONAL_ENTRIES_POSTGRES_TABLE_DDL,
  COMMIT_POSITION_TABLE_DDL,
  COMMAND_RECEIPTS_TABLE_DDL,
} from "./schema.js";

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
 * The baseline Triplex schema and ordered additive upgrades.
 *
 * DDL is imported from schema.ts so explicit host-owned migration execution and
 * convenience auto-migration use the same definitions. The baseline stays
 * unchanged for existing v1 databases.
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "triplex_baseline",
    up: [
      TRIPLES_TABLE_DDL,
      ...BASELINE_INDEX_DDLS,
      ENTITY_BLOBS_TABLE_DDL,
      ENTITY_SNAPSHOTS_TABLE_DDL,
      ...SNAPSHOT_INDEX_DDLS,
      COMMIT_POSITION_TABLE_DDL,
      COMMAND_RECEIPTS_TABLE_DDL,
    ],
  },
  {
    version: 2,
    name: "triplex_numeric_value_index",
    up: [NUMERIC_VALUE_INDEX_DDL],
  },
  {
    version: 3,
    name: "triplex_sealed_values",
    dialects: { sqlite: SEALED_VALUES_SQLITE_DDLS, pg: SEALED_VALUES_POSTGRES_DDLS },
    up: [SEALED_BLIND_INDEX_DDL],
  },
  {
    version: 4,
    name: "triplex_entity_recorded_position_index",
    up: [ENTITY_RECORDED_POSITION_INDEX_DDL],
  },
  {
    version: 5,
    name: "triplex_operational_entries",
    dialects: { pg: [OPERATIONAL_ENTRIES_POSTGRES_TABLE_DDL] },
    up: [OPERATIONAL_ENTRIES_TABLE_DDL, ...OPERATIONAL_ENTRY_INDEX_DDLS],
  },
  {
    version: 6,
    name: "triplex_live_precondition_index",
    dialects: { pg: [LIVE_PRECONDITION_INDEX_POSTGRES_DDL, "ANALYZE triples"] },
    up: [],
  },
  {
    version: 7,
    name: "triplex_transaction_entity_prefix_index",
    dialects: { pg: [TRANSACTION_ENTITY_PREFIX_INDEX_POSTGRES_DDL, "ANALYZE triples"] },
    up: [],
  },
  {
    version: 8,
    name: "triplex_interval_history_indexes",
    up: INTERVAL_HISTORY_INDEX_DDLS,
  },
];

export const runMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Ensure migrations table exists first
  yield* sql`
    CREATE TABLE IF NOT EXISTS triplex_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at BIGINT NOT NULL
    )
  `;

  // Get already applied migrations
  const applied = yield* sql<{ version: number }>`
    SELECT version FROM triplex_schema_migrations ORDER BY version
  `;
  const appliedVersions = new Set(applied.map((r) => r.version));

  // Run pending migrations
  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    const dialectStatements = sql.onDialectOrElse({
      orElse: () => [] as ReadonlyArray<string>,
      sqlite: () => migration.dialects?.sqlite ?? [],
      pg: () => migration.dialects?.pg ?? [],
    });

    // Each migration (and its applied record) commits atomically; the SQLite
    // v3 table rebuild in particular must never be observed half-done.
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
