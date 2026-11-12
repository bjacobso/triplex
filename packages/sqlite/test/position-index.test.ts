import { it } from "vitest";
import { Effect } from "effect";
import { sqliteInternalLayer } from "./SqliteInternalLayer.js";
import { positionIndexPlan } from "../../../test/fixtures/position-index.js";

it("uses an entity-position index for a selective historical cut", async () => {
  await Effect.runPromise(positionIndexPlan("sqlite").pipe(Effect.provide(sqliteInternalLayer())));
});
