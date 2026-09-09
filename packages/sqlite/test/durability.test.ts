import { EntityId, Triples, string } from "@bjacobso/triplex";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteTriples } from "../src/SqliteTriples.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("SQLite durability", () => {
  it("reopens committed facts and command receipts after the first runtime closes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "triplex-sqlite-durability-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "triplex.db");
    const entityId = EntityId.make("durability:entity");

    const first = await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        return yield* triples.transact(
          [
            {
              op: "assert",
              entityId,
              attribute: ":durability/value",
              value: string("persisted"),
            },
          ],
          { commandId: "durability:create" },
        );
      }).pipe(Effect.provide(SqliteTriples.layer({ filename }))),
    );

    const reopened = await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        return {
          facts: yield* triples.entity(entityId),
          receipt: yield* triples.transactionByCommand("durability:create"),
        };
      }).pipe(Effect.provide(SqliteTriples.layer({ filename }))),
    );

    expect(reopened.facts).toEqual([
      expect.objectContaining({
        entityId,
        attribute: ":durability/value",
        value: string("persisted"),
      }),
    ]);
    expect(reopened.receipt).toEqual(expect.objectContaining({ txId: first.txId }));
  });
});
