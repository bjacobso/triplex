import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { original } from "../02/story.ts";
import { makeStore } from "./temporal.ts";
import { answer } from "./run.ts";
import { JAN_1, JAN_5, MAR_1, MAR_2, MAR_10 } from "./story.ts";

describe("Part 3: Two clocks, two questions", () => {
  it("answers March 2 as known then and now, without erasing January", () => {
    expect(
      [JAN_1, JAN_5, MAR_1, MAR_2, MAR_10].map((time) =>
        new Date(time).toISOString(),
      ),
    ).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-05T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
      "2026-03-02T00:00:00.000Z",
      "2026-03-10T00:00:00.000Z",
    ]);
    const result = answer;
    expect(result.asKnownThen).toEqual([
      { ...original, validFrom: JAN_1 },
    ]);
    expect(result.asKnownNow).toEqual([]);
    expect(result.january).toEqual([
      {
        ...original,
        id: "training:2",
        validFrom: JAN_1,
        validTo: MAR_1,
      },
    ]);
    expect(
      result.journal.map((tx) => [tx.position, tx.recordedAt]),
    ).toEqual([
      [1, JAN_5],
      [2, MAR_10],
    ]);
  });

  it("includes valid starts and recorded commits, but excludes valid ends", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const store = makeStore(Effect.succeed(JAN_5));
        yield* store.transact([
          {
            op: "assert",
            fact: {
              ...original,
              validFrom: JAN_1,
              validTo: MAR_1,
            },
          },
        ]);
        for (const [validAt, recordedAt, expected] of [
          [JAN_1 - 1, JAN_5, []],
          [JAN_1, JAN_5 - 1, []],
          [JAN_1, JAN_5, ["training:1"]],
          [MAR_1 - 1, JAN_5, ["training:1"]],
          [MAR_1, JAN_5, []],
        ] as const) {
          const facts = yield* store.match(
            {},
            { validAt, recordedAt },
          );
          expect(facts.map((fact) => fact.id)).toEqual(expected);
        }
      }),
    );
  });

  it("retracts the whole valid interval at the recorded boundary", () => {
    Effect.runSync(
      Effect.gen(function* () {
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
        yield* store.transact([{ op: "retract", id: original.id }]);
        expect(
          (yield* store.match(
            {},
            {
              validAt: JAN_1,
              recordedAt: MAR_10 - 1,
            },
          )).map((fact) => fact.id),
        ).toEqual(["training:1"]);
        expect(
          yield* store.match(
            {},
            {
              validAt: JAN_1,
              recordedAt: MAR_10,
            },
          ),
        ).toEqual([]);
      }),
    );
  });

  it("rejects invalid intervals and backwards clocks without a journal entry", () => {
    Effect.runSync(
      Effect.gen(function* () {
        let now = JAN_5;
        const store = makeStore(Effect.sync(() => now));
        for (const [validFrom, validTo] of [
          [JAN_1, JAN_1],
          [MAR_2, MAR_1],
          [-1, MAR_1],
          [Number.NaN, MAR_1],
          [JAN_1, Infinity],
        ]) {
          const error = yield* store
            .transact([
              {
                op: "assert",
                fact: {
                  ...original,
                  validFrom: validFrom!,
                  validTo: validTo!,
                },
              },
            ])
            .pipe(Effect.flip);
          expect(error.message).toBe(
            "invalid valid interval: training:1",
          );
        }
        expect(yield* store.journal).toEqual([]);
        yield* store.transact([
          {
            op: "assert",
            fact: {
              ...original,
              validFrom: JAN_1,
            },
          },
        ]);
        now = JAN_1;
        const error = yield* store.transact([]).pipe(Effect.flip);
        expect(error.message).toBe(
          "recorded clock must not move backwards",
        );
        expect((yield* store.journal).length).toBe(1);
      }),
    );
  });
});
