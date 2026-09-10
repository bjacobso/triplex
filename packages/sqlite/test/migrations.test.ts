import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { migrations, runMigrations } from "@triplex-build/triplex-sql";
import { makeSqliteLayerUnmigrated } from "../src/SqliteLayer.js";

const runUnmigrated = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(makeSqliteLayerUnmigrated(":memory:"))));

describe("host-owned SQLite migrations", () => {
  it("starts without DDL and applies the exported migrations idempotently", async () => {
    const result = await runUnmigrated(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const before = yield* sql<{ name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'triples'
        `;

        yield* runMigrations;
        yield* runMigrations;

        const applied = yield* sql<{ version: number }>`
          SELECT version FROM triplex_schema_migrations ORDER BY version
        `;
        const columns = yield* sql.unsafe<{ name: string }>("PRAGMA table_info(triples)");
        const snapshotColumns = yield* sql.unsafe<{ name: string }>(
          "PRAGMA table_info(entity_snapshots)",
        );
        const blobColumns = yield* sql.unsafe<{ name: string }>("PRAGMA table_info(entity_blobs)");
        const receiptColumns = yield* sql.unsafe<{ name: string }>(
          "PRAGMA table_info(triplex_command_receipts)",
        );
        const indexes = yield* sql<{ name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'triples'
        `;
        return { before, applied, columns, snapshotColumns, blobColumns, receiptColumns, indexes };
      }),
    );

    expect(result.before).toHaveLength(0);
    expect(migrations.map(({ version }) => version)).toEqual([1]);
    expect(result.applied.map(({ version }) => version)).toEqual([1]);
    expect(result.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "recorded_at",
        "recorded_position",
        "retracted_at",
        "retracted_position",
        "valid_from",
        "valid_to",
      ]),
    );
    expect(result.columns.map(({ name }) => name)).not.toContain("created_at");
    expect(result.columns.map(({ name }) => name)).not.toContain("recorded_retracted_at");
    expect(result.snapshotColumns.map(({ name }) => name)).toContain("tx_position");
    expect(result.blobColumns.map(({ name }) => name)).not.toContain("ref_count");
    expect(result.receiptColumns.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["command_id", "transaction_id", "recorded_at"]),
    );
    expect(result.indexes.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["idx_attribute_history", "idx_attribute_temporal"]),
    );
  });

  it("treats an existing v1 database as current and preserves its data", async () => {
    const result = await runUnmigrated(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations;
        yield* sql`
          INSERT INTO triples (
            id, entity_id, attribute, value_type, value_string,
            recorded_at, recorded_position, valid_from, schema_version, tx_id
          ) VALUES (
            '00000000000000000000000000', 'migration:entity', ':migration/value',
            'string', 'preserved', 1, 1, 1, 1, '_tx/00000000000000000000000000'
          )
        `;

        yield* runMigrations;

        return yield* sql<{ value_string: string }>`
          SELECT value_string FROM triples WHERE entity_id = 'migration:entity'
        `;
      }),
    );

    expect(result).toEqual([{ value_string: "preserved" }]);
  });
});
