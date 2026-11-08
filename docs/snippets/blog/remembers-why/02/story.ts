import { Effect } from "effect";
import { makeStore, type Change } from "./log.ts";

// #region correction
export const original = {
  id: "training:1",
  entity: "worker:maria",
  attribute: ":worker/trained",
  value: true,
};

export const correction = Effect.gen(function* () {
  const store = makeStore();
  yield* store.transact([{ op: "assert", fact: original }]);
  yield* store.transact([
    { op: "retract", id: original.id },
    {
      op: "assert",
      fact: {
        ...original,
        id: "training:2",
        value: false,
      },
    },
  ]);
  return {
    current: yield* store.match({ entity: "worker:maria" }),
    journal: yield* store.journal,
  };
});

// current has training:2, value false.
// journal positions are [1, 2].
// Position 1 still asserts training:1, value true.
// #endregion correction

// #region rollback
export const rollback = Effect.gen(function* () {
  const store = makeStore();
  yield* store.transact([{ op: "assert", fact: original }]);
  const changes: ReadonlyArray<Change> = [
    { op: "retract", id: original.id },
    { op: "retract", id: "missing" },
  ];
  const error = yield* store.transact(changes).pipe(Effect.flip);
  return {
    message: error.message,
    current: yield* store.match({}),
    positions: (yield* store.journal).map((tx) => tx.position),
  };
});

// message: "assertion is not live: missing"
// current still has training:1, value true.
// positions: [1]
// #endregion rollback

// #region ambiguity
export const ambiguity = Effect.gen(function* () {
  const store = makeStore();
  yield* store.transact([{ op: "assert", fact: original }]);
  yield* store.transact([
    {
      op: "assert",
      fact: {
        ...original,
        id: "training:2",
        value: false,
      },
    },
  ]);
  return (yield* store.match({})).map((fact) => fact.value);
});

// [true, false]: asserting a replacement is not a retraction.
// #endregion ambiguity
