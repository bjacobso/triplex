import { NodeServices } from "@effect/platform-node";
import { DatabaseManager } from "@triplex-build/triplex";
import { RuntimeServicesLive, TripleStoreRuntimeLayer } from "@triplex-build/triplex/internal";
import { DatabaseManagerLive, DatabaseRegistryLive } from "@triplex-build/triplex-sql";
import { makeSqliteBackend } from "@triplex-build/triplex-sqlite";
import { Effect, Layer } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeDatabase } from "../src/operations.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("database CLI operations", () => {
  it("manages the complete SQLite database lifecycle", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "triplex-cli-test-"));
    temporaryDirectories.push(dataDir);

    const backend = makeSqliteBackend({ dataDir });
    const managerLayer = DatabaseManagerLive.pipe(
      Layer.provide(DatabaseRegistryLive),
      Layer.provide(backend),
      Layer.provide(RuntimeServicesLive),
      Layer.provide(TripleStoreRuntimeLayer),
      Layer.provide(NodeServices.layer),
    ) as Layer.Layer<DatabaseManager>;

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* executeDatabase({
          _tag: "database-create",
          name: "application",
          description: "Application database",
        });
        const listed = yield* executeDatabase({ _tag: "database-list" });
        const updated = yield* executeDatabase({
          _tag: "database-update",
          name: "application",
          description: "Primary database",
        });
        const cleared = yield* executeDatabase({
          _tag: "database-clear",
          name: "application",
        });
        const afterClear = yield* executeDatabase({
          _tag: "database-get",
          name: "application",
        });
        const deleted = yield* executeDatabase({
          _tag: "database-delete",
          name: "application",
        });
        const afterDelete = yield* executeDatabase({ _tag: "database-list" });
        return { created, listed, updated, cleared, afterClear, deleted, afterDelete };
      }).pipe(Effect.provide(managerLayer)),
    );

    expect(result.created).toEqual({
      database: expect.objectContaining({
        name: "application",
        description: "Application database",
        tripleCount: 0,
      }),
    });
    expect(result.listed).toEqual({
      databases: [expect.objectContaining({ name: "application", tripleCount: 0 })],
    });
    expect(result.updated).toEqual({
      database: expect.objectContaining({ description: "Primary database" }),
    });
    expect(result.cleared).toEqual({ success: true, database: "application" });
    expect(result.afterClear).toEqual({
      database: expect.objectContaining({
        name: "application",
        description: "Primary database",
        tripleCount: 0,
      }),
    });
    expect(result.deleted).toEqual({ database: "application", deleted: true });
    expect(result.afterDelete).toEqual({ databases: [] });
  });
});
