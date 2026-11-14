import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASELINE_MIGRATION_NAME,
  migrations,
  runMigrations,
  SchemaVersionError,
} from "@triplex-build/triplex-sql";
import {
  CurrentDialect,
  SqliteDialect,
  Triples,
  TriplesLive,
  TripleStoreRuntimeLayer,
} from "@triplex-internal/core/internal";
import { SqlQueryExecutorLive } from "@triplex-build/triplex-sql";
import { makeSqliteLayerUnmigrated } from "../src/SqliteLayer.js";
import { SqliteAdapterLive, SqliteAdapterUnmigrated } from "../src/SqliteAdapter.js";
import { SqliteTriples } from "../src/SqliteTriples.js";

const runUnmigrated = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(makeSqliteLayerUnmigrated(":memory:"))));

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const tempFile = async () => {
  const directory = await mkdtemp(join(tmpdir(), "triplex-sqlite-migrations-"));
  directories.push(directory);
  return join(directory, "triplex.db");
};

/** The schema history every Triplex 0.4 SQLite database records. */
const HISTORY_0_4 = [
  "triplex_baseline",
  "triplex_numeric_value_index",
  "triplex_sealed_values",
  "triplex_entity_recorded_position_index",
  "triplex_operational_entries",
  "triplex_live_precondition_index",
  "triplex_transaction_entity_prefix_index",
  "triplex_interval_history_indexes",
  "triplex_public_read_indexes",
  "triplex_key_store",
  "triplex_blind_tokens_only_on_facts",
  "triplex_blind_key_staging",
  "triplex_drop_prefix_indexes",
];

/** A file shaped like a 0.4 database: its migration history and a journal row in `triples`. */
const write04Database = (filename: string, history: readonly string[]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE triplex_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)`;
      for (const [index, name] of history.entries())
        yield* sql`INSERT INTO triplex_schema_migrations VALUES (${index + 1}, ${name}, 0)`;
      yield* sql`CREATE TABLE triples (id TEXT PRIMARY KEY, entity_id TEXT, attribute TEXT, value_type TEXT, value_number REAL, entity_type TEXT)`;
      yield* sql`INSERT INTO triples VALUES ('j1', '_tx/01', ':_tx/position', 'number', 1, '_Transaction')`;
    }).pipe(Effect.provide(makeSqliteLayerUnmigrated(filename))),
  );

const schemaVersionErrorOf = async (effect: Effect.Effect<unknown, unknown>) => {
  const error = await Effect.runPromise(Effect.flip(effect));
  expect(error).toBeInstanceOf(SchemaVersionError);
  return error as SchemaVersionError;
};

describe("host-owned SQLite migrations", () => {
  it("starts without DDL and applies the one baseline idempotently", async () => {
    const result = await runUnmigrated(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const before = yield* sql<{ name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'triples'
        `;

        yield* runMigrations;
        yield* runMigrations;

        const applied = yield* sql<{ version: number; name: string }>`
          SELECT version, name FROM triplex_schema_migrations ORDER BY version
        `;
        const columns = yield* sql.unsafe<{ name: string }>("PRAGMA table_info(triples)");
        const journalColumns = yield* sql.unsafe<{ name: string }>(
          "PRAGMA table_info(triplex_transactions)",
        );
        const entityColumns = yield* sql.unsafe<{ name: string; pk: number }>(
          "PRAGMA table_info(triplex_transaction_entities)",
        );
        const objects = yield* sql<{ type: string; name: string; tbl_name: string }>`
          SELECT type, name, tbl_name FROM sqlite_master
        `;
        const attributes = yield* sql<{ attribute: string }>`
          SELECT attribute FROM triplex_journal_attributes ORDER BY attribute
        `;
        return { before, applied, columns, journalColumns, entityColumns, objects, attributes };
      }),
    );

    expect(result.before).toHaveLength(0);
    expect(migrations.map(({ version, name }) => [version, name])).toEqual([
      [1, BASELINE_MIGRATION_NAME],
    ]);
    expect(result.applied.map(({ version, name }) => [version, name])).toEqual([
      [1, BASELINE_MIGRATION_NAME],
    ]);
    expect(result.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "recorded_at",
        "recorded_position",
        "retracted_at",
        "retracted_position",
        "valid_from",
        "valid_to",
        "value_sealed",
        "value_blind",
      ]),
    );
    expect(result.journalColumns.map(({ name }) => name)).toEqual([
      "tx_id",
      "position",
      "instant",
      "actor",
      "command_id",
      "correlation_id",
      "causation_id",
      "config_snapshot",
      "changes",
    ]);
    expect(
      result.entityColumns.filter(({ pk }) => pk > 0).map(({ name, pk }) => [name, pk]),
    ).toEqual([
      ["entity_id", 1],
      ["position", 2],
    ]);
    expect(result.attributes.map(({ attribute }) => attribute)).toHaveLength(8);
    const names = (type: string, table?: string) =>
      result.objects
        .filter(
          (object) => object.type === type && (table === undefined || object.tbl_name === table),
        )
        .map(({ name }) => name);
    expect(names("table")).not.toContain("triplex_command_receipts");
    expect(names("view")).toEqual(["triplex_journal_facts"]);
    expect(names("index", "triplex_transactions")).toEqual(
      expect.arrayContaining(["idx_transactions_instant"]),
    );
    expect(names("index", "triplex_transaction_entities")).toEqual(
      expect.arrayContaining(["idx_transaction_entities_position"]),
    );
    expect(names("index", "triples")).toEqual(
      expect.arrayContaining([
        "idx_attribute_history",
        "idx_attribute_temporal",
        "idx_attr_numeric",
        "idx_attr_blind",
        "idx_entity",
        "idx_entity_recorded_position",
        "idx_tx_id",
      ]),
    );
    // Indexes that served only journal rows, and prefixes of other indexes, are gone.
    for (const dropped of [
      "idx_journal_instant_position",
      "idx_attribute",
      "idx_recorded_position",
    ])
      expect(names("index", "triples")).not.toContain(dropped);
  });

  it("refuses a Triplex 0.4 database everywhere and changes nothing", async () => {
    const filename = await tempFile();
    await write04Database(filename, HISTORY_0_4);
    const client = makeSqliteLayerUnmigrated(filename);

    const migrated = await schemaVersionErrorOf(runMigrations.pipe(Effect.provide(client)));
    expect(migrated).toMatchObject({ expectedVersion: 1, actualVersion: 13 });
    expect(migrated.message).toContain("Triplex 0.4 or earlier");
    expect(migrated.message).toContain("Start a fresh database");

    // The auto-migrating layer, the read-only layer, and adapters over a host client.
    for (const layer of [
      SqliteTriples.layer({ filename }),
      SqliteTriples.layerReadOnly({ filename }),
      TriplesLive.pipe(
        Layer.provide(SqlQueryExecutorLive),
        Layer.provide(SqliteAdapterLive),
        Layer.provide(Layer.succeed(CurrentDialect, SqliteDialect)),
        Layer.provide(makeSqliteLayerUnmigrated(filename)),
        Layer.provide(TripleStoreRuntimeLayer),
      ),
      TriplesLive.pipe(
        Layer.provide(SqlQueryExecutorLive),
        Layer.provide(SqliteAdapterUnmigrated),
        Layer.provide(Layer.succeed(CurrentDialect, SqliteDialect)),
        Layer.provide(makeSqliteLayerUnmigrated(filename)),
        Layer.provide(TripleStoreRuntimeLayer),
      ),
    ]) {
      const error = await schemaVersionErrorOf(
        Triples.pipe(Effect.provide(Layer.fresh(layer)), Effect.scoped),
      );
      expect(error.actualVersion).toBe(13);
    }

    const untouched = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return {
          history: yield* sql<{ version: number }>`SELECT version FROM triplex_schema_migrations`,
          tables: yield* sql<{ name: string }>`
            SELECT name FROM sqlite_master WHERE name LIKE 'triplex_transaction%'
          `,
        };
      }).pipe(Effect.provide(client)),
    );
    expect(untouched.history).toHaveLength(13);
    expect(untouched.tables).toEqual([]);
  });

  it("refuses the 0.1 baseline history too, though its version number matches", async () => {
    const filename = await tempFile();
    await write04Database(filename, ["triplex_baseline"]);
    const error = await schemaVersionErrorOf(
      Triples.pipe(Effect.provide(Layer.fresh(SqliteTriples.layer({ filename }))), Effect.scoped),
    );
    expect(error).toMatchObject({ actualVersion: 1, actualName: "triplex_baseline" });
  });
});
