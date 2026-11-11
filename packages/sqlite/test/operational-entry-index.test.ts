import { it } from "vitest";
import { Effect } from "effect";
import { SqliteTriples } from "../src/index.js";
import { operationalEntryIndexPlan } from "../../../test/fixtures/operational-entry-index.js";

it(
  "keeps inbox/outbox operations indexed with 10 and 10000 acknowledged entries",
  { timeout: 30000 },
  async () => {
    await Effect.runPromise(
      operationalEntryIndexPlan("sqlite").pipe(Effect.provide(SqliteTriples.layerMemory)),
    );
  },
);
