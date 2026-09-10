import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { MigrationError } from "@triplex-build/triplex/internal";
import {
  TRIPLES_TABLE_DDL,
  INDEX_DDLS,
  ENTITY_BLOBS_TABLE_DDL,
  ENTITY_SNAPSHOTS_TABLE_DDL,
  SNAPSHOT_INDEX_DDLS,
  COMMIT_POSITION_TABLE_DDL,
  COMMAND_RECEIPTS_TABLE_DDL,
} from "./schema.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: ReadonlyArray<string>;
}

/**
 * The complete greenfield Triplex schema.
 *
 * DDL is imported from schema.ts so explicit host-owned migration execution and
 * convenience auto-migration use the same single v1 definition.
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "triplex_baseline",
    up: [
      TRIPLES_TABLE_DDL,
      ...INDEX_DDLS,
      ENTITY_BLOBS_TABLE_DDL,
      ENTITY_SNAPSHOTS_TABLE_DDL,
      ...SNAPSHOT_INDEX_DDLS,
      COMMIT_POSITION_TABLE_DDL,
      COMMAND_RECEIPTS_TABLE_DDL,
    ],
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

    for (const statement of migration.up) {
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
  }
});
