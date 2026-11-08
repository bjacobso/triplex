import { Effect } from "effect";
import { makeStore } from "./facts.ts";

// #region first-fact
export const firstFact = Effect.gen(function* () {
  const store = makeStore();
  yield* store.put({
    entity: "worker:maria",
    attribute: ":worker/trained",
    value: true,
  });
  return yield* store.match({ entity: "worker:maria" });
});

// Effect.runSync(firstFact) returns:
// [
//   {
//     entity: "worker:maria",
//     attribute: ":worker/trained",
//     value: true,
//   },
// ]
// #endregion first-fact

// #region questions
export const questions = Effect.gen(function* () {
  const store = makeStore();
  yield* store.put({
    entity: "worker:maria",
    attribute: ":worker/name",
    value: "Maria",
  });
  yield* store.put({
    entity: "worker:maria",
    attribute: ":worker/trained",
    value: true,
  });
  yield* store.put({
    entity: "worker:lee",
    attribute: ":worker/trained",
    value: false,
  });

  return {
    trained: yield* store.match({
      attribute: ":worker/trained",
      value: true,
    }),
    untrained: yield* store.match({ value: false }),
    absent: yield* store.match({ entity: "worker:jo" }),
    all: yield* store.match({}),
  };
});
// #endregion questions

// #region correction
export const correction = Effect.gen(function* () {
  const store = makeStore();
  const identity = {
    entity: "worker:maria",
    attribute: ":worker/trained",
  };

  yield* store.put({ ...identity, value: true });
  const before = yield* store.match(identity);
  yield* store.put({ ...identity, value: false });

  return {
    before,
    after: yield* store.match(identity),
    evidence: yield* store.match({
      ...identity,
      value: true,
    }),
  };
});

// Effect.runSync(correction):
// before[0].value === true
// after[0].value === false
// evidence is []
// #endregion correction

// #region indistinguishable
export const noEarlierTraining = Effect.gen(function* () {
  const store = makeStore();
  yield* store.put({
    entity: "worker:maria",
    attribute: ":worker/trained",
    value: false,
  });
  return yield* store.match({});
});

// The store cannot distinguish these two histories:
// true, then false  -> [{ ...identity, value: false }]
// false only        -> [{ ...identity, value: false }]
// #endregion indistinguishable
