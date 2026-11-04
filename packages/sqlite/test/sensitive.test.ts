import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findPlaintext,
  makeSealedStorageSuite,
  makeSensitiveConformanceSuite,
  makeTriplesConformanceSuite,
  sensitiveConformanceLayer,
} from "@triplex-build/triplex-testkit";

import { makeSqliteLayer } from "../src/SqliteLayer.js";
import { SqliteTriples } from "../src/SqliteTriples.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const run = (effect: Effect.Effect<void, unknown, never>) =>
  expect(Effect.runPromise(Effect.scoped(effect))).resolves.toBeUndefined();

describe("SQLite sensitive values", () => {
  it("passes the sealed-storage engine contract", async () => {
    await run(
      makeSealedStorageSuite().pipe(Effect.provide(Layer.fresh(SqliteTriples.layerMemory))),
    );
  });

  it("passes the sensitive decorator contract", async () => {
    await run(
      makeSensitiveConformanceSuite().pipe(
        Effect.provide(sensitiveConformanceLayer(Layer.fresh(SqliteTriples.layerMemory))),
      ),
    );
  });

  it("keeps the full Triples contract through the decorator", async () => {
    await run(
      makeTriplesConformanceSuite().pipe(
        Effect.provide(sensitiveConformanceLayer(Layer.fresh(SqliteTriples.layerMemory))),
      ),
    );
  });

  it("never persists planted plaintext in any table, index, journal or file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "triplex-sensitive-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "triplex.db");

    await run(
      makeSensitiveConformanceSuite().pipe(
        Effect.provide(sensitiveConformanceLayer(SqliteTriples.layer({ filename }))),
      ),
    );

    const dump = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const objects = yield* sql<{ name: string; type: string; sql: string | null }>`
          SELECT name, type, sql FROM sqlite_master
        `;
        const parts: string[] = [JSON.stringify(objects)];
        for (const table of objects.filter((object) => object.type === "table")) {
          const rows = yield* sql.unsafe(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`);
          parts.push(table.name, JSON.stringify(rows));
        }
        return { text: parts.join("\n"), tables: objects.filter((o) => o.type === "table") };
      }).pipe(Effect.provide(makeSqliteLayer(filename)), Effect.scoped),
    );
    expect(dump.tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(["triples", "triplex_command_receipts"]),
    );
    expect(dump.text).toContain("value_blind");
    // Positive control: the same scan finds a non-sensitive plaintext value.
    expect(findPlaintext(dump.text, "Grace")).not.toEqual([]);
    expect(findPlaintext(dump.text)).toEqual([]);

    // Raw bytes of the database, WAL and shared-memory files, after close.
    let allBytes = "";
    for (const file of await readdir(directory)) {
      const bytes = (await readFile(join(directory, file))).toString("latin1");
      allBytes += bytes;
      expect(findPlaintext(bytes), file).toEqual([]);
    }
    expect(allBytes).toContain("Grace");
  });
});
