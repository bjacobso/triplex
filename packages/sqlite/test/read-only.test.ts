import { Cause, Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EntityId, Triples, WriteError } from "@triplex-internal/core";
import { migrations, runMigrations, SchemaVersionError } from "@triplex-build/triplex-sql";

import { SqliteTriples } from "../src/SqliteTriples.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const tempFile = async () => {
  const directory = await mkdtemp(join(tmpdir(), "triplex-readonly-"));
  directories.push(directory);
  return { directory, filename: join(directory, "triplex.db") };
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.scoped(effect));
const runExit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(Effect.scoped(effect));

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  const failure = exit.cause.reasons.find(Cause.isFailReason);
  if (!failure) throw new Error(Cause.pretty(exit.cause));
  return failure.error;
};

const ada = EntityId.make("person:ada");
const LATEST = Math.max(...migrations.map((migration) => migration.version));

const writeAda = Effect.gen(function* () {
  const triples = yield* Triples;
  yield* triples.assert({
    entityId: ada,
    attribute: ":person/name",
    value: { type: "string", value: "Ada" },
  });
});

const readAda = Effect.gen(function* () {
  const triples = yield* Triples;
  return (yield* triples.entity(ada)).map((fact) => fact.value);
});

const snapshot = async (directory: string) => {
  const files: Record<string, string> = {};
  for (const name of (await readdir(directory)).sort()) {
    files[name] = (await readFile(join(directory, name))).toString("base64");
  }
  return files;
};

describe("read-only SQLite", () => {
  it("reads a migrated file, refuses writes and leaves the file unchanged", async () => {
    const { directory, filename } = await tempFile();
    await run(writeAda.pipe(Effect.provide(SqliteTriples.layer({ filename }))));
    const before = await snapshot(directory);

    const result = await run(
      Effect.gen(function* () {
        const values = yield* readAda;
        const write = yield* Effect.exit(writeAda);
        return { values, write };
      }).pipe(Effect.provide(SqliteTriples.layerReadOnly({ filename }))),
    );
    expect(result.values).toEqual([{ type: "string", value: "Ada" }]);
    expect(failureOf(result.write)).toBeInstanceOf(WriteError);
    // The database file is unchanged. Reading a WAL-mode file read-only still
    // creates SQLite's shared-memory side files; the WAL stays empty.
    const after = await snapshot(directory);
    expect(after["triplex.db"]).toBe(before["triplex.db"]);
    expect(after["triplex.db-wal"] ?? "").toBe("");
  });

  it("fails with SchemaVersionError for a file with another schema history, and changes nothing", async () => {
    const { filename } = await tempFile();
    const client = SqliteClient.layer({ filename });
    // A history like Triplex 0.4's: a different baseline and later versions.
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations;
        yield* sql`UPDATE triplex_schema_migrations SET name = 'triplex_baseline'`;
        yield* sql`INSERT INTO triplex_schema_migrations VALUES (13, 'triplex_drop_prefix_indexes', 0)`;
      }).pipe(Effect.provide(client)),
    );
    const exit = await runExit(
      readAda.pipe(Effect.provide(SqliteTriples.layerReadOnly({ filename }))),
    );
    const error = failureOf(exit);
    expect(error).toBeInstanceOf(SchemaVersionError);
    expect(error).toMatchObject({ expectedVersion: LATEST, actualVersion: 13 });
    const [latest] = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{
          version: number;
        }>`SELECT MAX(version) AS version FROM triplex_schema_migrations`;
      }).pipe(Effect.provide(Layer.fresh(client))),
    );
    expect(latest!.version).toBe(13);
  });

  it("reports version zero for a file with no Triplex schema", async () => {
    const { filename } = await tempFile();
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE unrelated (id INTEGER)`;
      }).pipe(Effect.provide(SqliteClient.layer({ filename }))),
    );
    const exit = await runExit(
      readAda.pipe(Effect.provide(SqliteTriples.layerReadOnly({ filename }))),
    );
    expect(failureOf(exit)).toMatchObject({ _tag: "SchemaVersionError", actualVersion: 0 });
  });
});
