import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { original } from "../02/story.ts";
import { JAN_1, MAR_10 } from "../03/story.ts";
import { makeStore } from "./commands.ts";
import { answer } from "./run.ts";
import { recordTraining, rulesGap } from "./story.ts";

describe("Part 4: Someone did this", () => {
  it("returns the original receipt after rejecting a retry", () => {
    const result = answer;
    expect(result.error).toBe(
      "command already committed: record-training:maria:request-17",
    );
    expect(result.first).toEqual({
      position: 1,
      recordedAt: MAR_10,
      command: {
        id: "record-training:maria:request-17",
        actor: "user:pat",
        rules: "hr-2026.1",
      },
      changes: [
        {
          op: "assert",
          fact: {
            ...original,
            validFrom: JAN_1,
          },
        },
      ],
    });
    expect(result.receipt).toEqual(result.first);
    expect(result.journal).toEqual([result.first]);
  });

  it("does not mistake a rule label for enforcement", () => {
    const result = Effect.runSync(rulesGap);
    expect(result.facts).toEqual([
      {
        ...original,
        value: "yes",
        validFrom: JAN_1,
      },
    ]);
    expect(result.receipt?.command).toEqual(recordTraining);
  });

  it("claims command IDs in the same boundary as facts and receipts", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = makeStore(Effect.succeed(MAR_10));
        expect(yield* store.receipt("unknown")).toBeUndefined();
        const attempts = ["first", "second"].map((id) =>
          store
            .transact(recordTraining, [
              {
                op: "assert",
                fact: {
                  ...original,
                  id,
                  validFrom: JAN_1,
                },
              },
            ])
            .pipe(Effect.result),
        );
        const results = yield* Effect.all(attempts, {
          concurrency: "unbounded",
        });
        expect(results.map((result) => result._tag).sort()).toEqual(
          ["Failure", "Success"],
        );
        const journal = yield* store.journal;
        expect(journal).toHaveLength(1);
        expect(yield* store.receipt(recordTraining.id)).toEqual(
          journal[0],
        );
        Object.assign(journal[0]!.command, { actor: "tampered" });
        expect(
          (yield* store.receipt(recordTraining.id))?.command.actor,
        ).toBe("user:pat");
      }),
    );
  });

  it("allows a failed command ID to be retried with a valid batch", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const store = makeStore(Effect.succeed(MAR_10));
        yield* store
          .transact(recordTraining, [
            { op: "retract", id: "missing" },
          ])
          .pipe(Effect.flip);
        expect(
          yield* store.receipt(recordTraining.id),
        ).toBeUndefined();
        expect(yield* store.journal).toEqual([]);
        const receipt = yield* store.transact(recordTraining, [
          {
            op: "assert",
            fact: { ...original, validFrom: JAN_1 },
          },
        ]);
        expect(receipt.position).toBe(1);
      }),
    );
  });
});
