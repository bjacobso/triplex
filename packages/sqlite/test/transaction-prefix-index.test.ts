import { it } from "vitest";
import { Effect } from "effect";
import { SqliteTriples } from "../src/index.js";
import { transactionPrefixIndexPlan } from "../../../test/fixtures/transaction-prefix-index.js";
it(
  "indexes entity-prefix transaction candidates with 10 and 10000 unrelated commands",
  { timeout: 30000 },
  async () => {
    await Effect.runPromise(
      transactionPrefixIndexPlan("sqlite").pipe(Effect.provide(SqliteTriples.layerMemory)),
    );
  },
);
