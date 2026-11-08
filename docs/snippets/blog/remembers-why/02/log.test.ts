import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeStore } from "./log.ts";
import { answer } from "./run.ts";
import { ambiguity, original, rollback } from "./story.ts";

describe("Part 2: Nothing is overwritten", () => {
  it("preserves the corrected assertion in the journal", () => {
    const result = answer;
    const corrected = {
      ...original,
      id: "training:2",
      value: false,
    };
    expect(result.current).toEqual([corrected]);
    expect(result.journal).toEqual([
      { position: 1, changes: [{ op: "assert", fact: original }] },
      {
        position: 2,
        changes: [
          { op: "retract", id: original.id },
          { op: "assert", fact: corrected },
        ],
      },
    ]);
    expect(Effect.runSync(ambiguity)).toEqual([true, false]);
  });

  it("rolls back the whole batch and does not consume a position", () => {
    expect(Effect.runSync(rollback)).toEqual({
      message: "assertion is not live: missing",
      current: [original],
      positions: [1],
    });
  });

  it("never reuses an assertion ID, including within one batch", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const store = makeStore();
        const assertion = { op: "assert", fact: original } as const;
        const duplicate = yield* store
          .transact([assertion, assertion])
          .pipe(Effect.flip);
        expect(duplicate.message).toBe(
          "assertion ID already used: training:1",
        );
        expect(yield* store.journal).toEqual([]);
        yield* store.transact([assertion]);
        yield* store.transact([{ op: "retract", id: original.id }]);
        expect(
          (yield* store.transact([assertion]).pipe(Effect.flip))
            .message,
        ).toBe("assertion ID already used: training:1");
        expect(
          (yield* store.journal).map((tx) => tx.position),
        ).toEqual([1, 2]);
      }),
    );
  });

  it("serializes competing retractions and isolates returned copies", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = makeStore();
        const input = { ...original };
        const tx = yield* store.transact([
          { op: "assert", fact: input },
        ]);
        input.value = false;
        Object.assign(tx, { position: 999 });
        const facts = yield* store.match({});
        Object.assign(facts[0]!, { value: false });
        expect(yield* store.match({})).toEqual([original]);
        const retract = store
          .transact([{ op: "retract", id: original.id }])
          .pipe(Effect.result);
        const results = yield* Effect.all([retract, retract], {
          concurrency: "unbounded",
        });
        expect(results.map((result) => result._tag).sort()).toEqual(
          ["Failure", "Success"],
        );
        expect(yield* store.match({})).toEqual([]);
        expect(
          (yield* store.journal).map((entry) => entry.position),
        ).toEqual([1, 2]);
      }),
    );
  });
});
