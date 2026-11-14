/** Ask 0019 (A), condition 2 on SQLite: four connections to one file race one command ID. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { Triples } from "@triplex-internal/core";
import { SqliteTriples } from "../src/SqliteTriples.js";
import { commandFirstWriterPlan } from "../../../test/fixtures/command-first-writer.js";

it(
  "keeps first-writer-wins for one command ID across concurrent connections",
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "triplex-command-race-"));
    try {
      const filename = join(directory, "triplex.db");
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const contexts = yield* Effect.forEach([0, 1, 2, 3], () =>
              Layer.build(Layer.fresh(SqliteTriples.layerWithSqlClient({ filename }))),
            );
            const writers = contexts.map((context) => Context.get(context, Triples));
            yield* commandFirstWriterPlan("sqlite", writers).pipe(
              Effect.provideService(
                SqlClient.SqlClient,
                Context.get(contexts[0]!, SqlClient.SqlClient),
              ),
            );
          }),
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
