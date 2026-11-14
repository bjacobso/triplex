/**
 * Two connections that open a brand-new SQLite file at the same time both
 * succeed: the second waits for the first to finish schema setup.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { Triples } from "@triplex-internal/core";
import { SqliteTriples } from "../src/SqliteTriples.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it(
  "lets concurrent first opens of a new file both succeed with one schema",
  { timeout: 60_000 },
  async () => {
    for (let round = 0; round < 10; round++) {
      const directory = await mkdtemp(join(tmpdir(), "triplex-first-open-"));
      directories.push(directory);
      const filename = join(directory, "triplex.db");
      const open = Effect.gen(function* () {
        const triples = yield* Triples;
        const sql = yield* SqlClient.SqlClient;
        const position = yield* triples.currentPosition();
        const history = yield* sql<{ version: number; name: string }>`
        SELECT version, name FROM triplex_schema_migrations ORDER BY version`;
        const objects = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master ORDER BY name`;
        return { position, history, objects: objects.map((object) => object.name) };
      }).pipe(
        Effect.provide(Layer.fresh(SqliteTriples.layerWithSqlClient({ filename }))),
        Effect.scoped,
      );
      const [first, second] = await Effect.runPromise(
        Effect.all([open, open, open], { concurrency: "unbounded" }),
      );
      expect(first!.position).toBe(0);
      expect(first!.history).toHaveLength(1);
      expect(second).toEqual(first);
    }
  },
);
