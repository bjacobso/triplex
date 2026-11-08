import { Effect } from "effect";
import { original } from "../02/story.ts";
import { JAN_1, MAR_2, MAR_10 } from "../03/story.ts";
import { makeStore, type Command } from "./commands.ts";

// #region command
export const recordTraining: Command = {
  id: "record-training:maria:request-17",
  actor: "user:pat",
  rules: "hr-2026.1",
};

export const retry = Effect.gen(function* () {
  const store = makeStore(Effect.succeed(MAR_10));
  const changes = [
    {
      op: "assert",
      fact: {
        ...original,
        validFrom: JAN_1,
      },
    },
  ] as const;
  const first = yield* store.transact(recordTraining, changes);
  const duplicate = yield* store
    .transact(recordTraining, changes)
    .pipe(Effect.flip);
  const receipt = yield* store.receipt(recordTraining.id);

  return {
    first,
    receipt,
    error: duplicate.message,
    journal: yield* store.journal,
  };
});

// error:
// "command already committed: record-training:maria:request-17"
// first and receipt have position 1; journal has one entry.
// #endregion command

// #region rules-gap
export const rulesGap = Effect.gen(function* () {
  const store = makeStore(Effect.succeed(MAR_10));
  yield* store.transact(recordTraining, [
    {
      op: "assert",
      fact: {
        ...original,
        value: "yes",
        validFrom: JAN_1,
      },
    },
  ]);
  return {
    facts: yield* store.match(
      {},
      {
        validAt: MAR_2,
        recordedAt: MAR_10,
      },
    ),
    receipt: yield* store.receipt(recordTraining.id),
  };
});

// The receipt says hr-2026.1. The value "yes" still commits.
// Recording a rule label doesn't enforce any rule.
// #endregion rules-gap
