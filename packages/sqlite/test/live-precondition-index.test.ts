import { it } from "vitest";
import { Effect } from "effect";
import { SqliteTriples } from "../src/index.js";
import { livePreconditionIndexPlan } from "../../../test/fixtures/live-precondition-index.js";
it(
  "bounds cheap guards with 10 and 10000 historical and unrelated facts",
  { timeout: 30000 },
  async () => {
    await Effect.runPromise(
      livePreconditionIndexPlan("sqlite").pipe(Effect.provide(SqliteTriples.layerMemory)),
    );
  },
);
