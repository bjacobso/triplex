import { Effect } from "effect";
import { original } from "../02/story.ts";
import { makeStore } from "./temporal.ts";

// #region dates
export const JAN_1 = Date.UTC(2026, 0, 1);
export const JAN_5 = Date.UTC(2026, 0, 5);
export const MAR_1 = Date.UTC(2026, 2, 1);
export const MAR_2 = Date.UTC(2026, 2, 2);
export const MAR_10 = Date.UTC(2026, 2, 10);
// #endregion dates

// #region correction
export const twoClocks = Effect.gen(function* () {
  let now = JAN_5;
  const store = makeStore(Effect.sync(() => now));
  yield* store.transact([
    {
      op: "assert",
      fact: {
        ...original,
        validFrom: JAN_1,
      },
    },
  ]);

  now = MAR_10;
  yield* store.transact([
    { op: "retract", id: original.id },
    {
      op: "assert",
      fact: {
        ...original,
        id: "training:2",
        validFrom: JAN_1,
        validTo: MAR_1,
      },
    },
  ]);

  return {
    asKnownThen: yield* store.match(
      {},
      {
        validAt: MAR_2,
        recordedAt: MAR_2,
      },
    ),
    asKnownNow: yield* store.match(
      {},
      {
        validAt: MAR_2,
        recordedAt: MAR_10,
      },
    ),
    january: yield* store.match(
      {},
      {
        validAt: JAN_5,
        recordedAt: MAR_10,
      },
    ),
    journal: yield* store.journal,
  };
});

// asKnownThen: [training:1] — we believed Maria was trained.
// asKnownNow: [] — the corrected interval ended on March 1.
// january: [training:2] — January is still covered.
// #endregion correction
