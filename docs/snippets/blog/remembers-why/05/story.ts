import { Effect, Schema } from "effect";
import { JAN_1, MAR_2, MAR_10 } from "../03/story.ts";
import { recordTraining } from "../04/story.ts";
import { makeStore, Worker } from "./validation.ts";

// #region onboarding
export const onboard = (entity: string, code: string) =>
  (
    [
      [":entity/type", "Worker"],
      [":worker/code", code],
      [":worker/trained", true],
    ] as const
  ).map(([attribute, value], index) => ({
    op: "assert" as const,
    fact: {
      id: `${entity}:${index}`,
      entity,
      attribute,
      value,
      validFrom: JAN_1,
    },
  }));

export const correction = Effect.gen(function* () {
  const store = makeStore(Effect.succeed(MAR_10));
  yield* store.transact(
    recordTraining,
    onboard("worker:maria", "M-17"),
  );
  const command = { ...recordTraining, id: "correct:maria" };
  const error = yield* store
    .transact(command, [
      { op: "retract", id: "worker:maria:2" },
      {
        op: "assert",
        fact: {
          id: "training:corrected",
          entity: "worker:maria",
          attribute: ":worker/trained",
          value: "yes",
          validFrom: JAN_1,
        },
      },
    ])
    .pipe(Effect.flip);

  return {
    message: error.message,
    current: yield* store.match(
      {},
      {
        validAt: MAR_2,
        recordedAt: MAR_10,
      },
    ),
    receipt: yield* store.receipt(command.id),
    journal: yield* store.journal,
  };
});
// The failed correction leaves Maria trained, one journal
// entry, and no receipt for correct:maria.
// #endregion onboarding

// #region shape
export const goodShape = {
  ":entity/type": "Worker",
  ":worker/code": "M-17",
  ":worker/trained": true,
};

export const shapeOnly =
  Schema.decodeUnknownEffect(Worker)(goodShape);

// This shape is valid for Maria, and for a second worker.
// Shape alone cannot make the code unique across entities.
// #endregion shape

// #region uniqueness
export const duplicateCode = Effect.gen(function* () {
  const store = makeStore(Effect.succeed(MAR_10));
  yield* store.transact(
    recordTraining,
    onboard("worker:maria", "M-17"),
  );
  const error = yield* store
    .transact(
      { ...recordTraining, id: "onboard:lee" },
      onboard("worker:lee", "M-17"),
    )
    .pipe(Effect.flip);
  return {
    message: error.message,
    journal: yield* store.journal,
  };
});

// message: "worker code already used: M-17"
// The journal still has one entry.
// #endregion uniqueness
