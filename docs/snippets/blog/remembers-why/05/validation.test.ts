import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { JAN_1, MAR_1, MAR_2, MAR_10 } from "../03/story.ts";
import { recordTraining } from "../04/story.ts";
import { makeStore } from "./validation.ts";
import { answer } from "./run.ts";
import {
  duplicateCode,
  goodShape,
  onboard,
  shapeOnly,
} from "./story.ts";

describe("Part 5: A shape is not an invariant", () => {
  it("decodes a shape but rolls back a mistyped correction", () => {
    expect(Effect.runSync(shapeOnly)).toEqual(goodShape);
    const result = answer;
    expect(result.message).toBe(
      'Expected boolean\n  at [":worker/trained"]',
    );
    expect(
      result.current.map((fact) => [fact.attribute, fact.value]),
    ).toEqual([
      [":entity/type", "Worker"],
      [":worker/code", "M-17"],
      [":worker/trained", true],
    ]);
    expect(result.receipt).toBeUndefined();
    expect(result.journal).toHaveLength(1);
    expect(Effect.runSync(duplicateCode).message).toBe(
      "worker code already used: M-17",
    );
    expect(Effect.runSync(duplicateCode).journal).toHaveLength(1);
  });

  it("rejects malformed input, missing fields, extra attributes and cardinality", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const store = makeStore(Effect.succeed(MAR_10));
        const facts = onboard("worker:maria", "M-17");
        const attempts = [
          [{ op: "erase", id: "worker:maria:0" }],
          facts.slice(0, 2),
          [
            ...facts,
            {
              op: "assert",
              fact: {
                id: "extra",
                entity: "worker:maria",
                attribute: "__proto__",
                value: "unexpected",
                validFrom: JAN_1,
              },
            },
          ],
          [
            ...facts,
            {
              op: "assert",
              fact: {
                id: "extra",
                entity: "worker:maria",
                attribute: ":worker/trained",
                value: false,
                validFrom: JAN_1,
              },
            },
          ],
        ];
        for (const input of attempts) {
          yield* store
            .transact(recordTraining, input)
            .pipe(Effect.flip);
          expect(yield* store.journal).toEqual([]);
          expect(
            yield* store.receipt(recordTraining.id),
          ).toBeUndefined();
        }
        expect(
          (yield* store.transact(recordTraining, facts)).position,
        ).toBe(1);
      }),
    );
  });

  it("checks expiry boundaries, not only the state at commit time", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const store = makeStore(Effect.succeed(JAN_1));
        const facts = onboard("worker:maria", "M-17");
        const expiring = facts.map((change) => ({
          ...change,
          fact: {
            ...change.fact,
            ...(change.fact.attribute === ":worker/trained"
              ? { validTo: MAR_1 }
              : {}),
          },
        }));
        const error = yield* store
          .transact(recordTraining, expiring)
          .pipe(Effect.flip);
        expect(error._tag).toBe("SchemaError");
        expect(error.message).toContain(":worker/trained");
        expect(yield* store.journal).toEqual([]);
        yield* store.transact(recordTraining, [
          ...expiring,
          {
            op: "assert",
            fact: {
              id: "after-expiry",
              entity: "worker:maria",
              attribute: ":worker/trained",
              value: false,
              validFrom: MAR_1,
            },
          },
        ]);
        expect(
          (yield* store.match(
            { attribute: ":worker/trained" },
            {
              validAt: MAR_1,
              recordedAt: JAN_1,
            },
          )).map((fact) => fact.value),
        ).toEqual([false]);
      }),
    );
  });

  it("permits a code handover at an exclusive end, but rejects overlap", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const store = makeStore(Effect.succeed(JAN_1));
        yield* store.transact(
          recordTraining,
          onboard("worker:maria", "M-17").map((change) => ({
            ...change,
            fact: { ...change.fact, validTo: MAR_1 },
          })),
        );
        yield* store.transact(
          { ...recordTraining, id: "onboard:lee" },
          onboard("worker:lee", "M-17").map((change) => ({
            ...change,
            fact: { ...change.fact, validFrom: MAR_1 },
          })),
        );
        for (const [validAt, entity] of [
          [MAR_1 - 1, "worker:maria"],
          [MAR_1, "worker:lee"],
        ] as const) {
          expect(
            (yield* store.match(
              { attribute: ":worker/code" },
              { validAt, recordedAt: JAN_1 },
            )).map((fact) => fact.entity),
          ).toEqual([entity]);
        }
        const error = yield* store
          .transact(
            { ...recordTraining, id: "onboard:jo" },
            onboard("worker:jo", "M-17").map((change) => ({
              ...change,
              fact: { ...change.fact, validFrom: MAR_2 },
            })),
          )
          .pipe(Effect.flip);
        expect(error.message).toBe(
          "worker code already used: M-17",
        );
        expect((yield* store.journal).length).toBe(2);
        expect(yield* store.receipt("onboard:jo")).toBeUndefined();
      }),
    );
  });

  it("serializes competing unique-code claims and leaves the failed ID reusable", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = makeStore(Effect.succeed(MAR_10));
        const commands = ["maria", "lee"].map((worker) => ({
          ...recordTraining,
          id: `onboard:${worker}`,
        }));
        const results = yield* Effect.all(
          commands.map((command, index) =>
            store
              .transact(command, onboard(`worker:${index}`, "M-17"))
              .pipe(Effect.result),
          ),
          { concurrency: "unbounded" },
        );
        expect(results.map((result) => result._tag).sort()).toEqual(
          ["Failure", "Success"],
        );
        const failed = results.findIndex(
          (result) => result._tag === "Failure",
        );
        const command = commands[failed]!;
        expect(yield* store.receipt(command.id)).toBeUndefined();
        expect((yield* store.journal).length).toBe(1);
        const receipt = yield* store.transact(
          command,
          onboard(`worker:${failed}`, "L-23"),
        );
        expect(receipt.position).toBe(2);
        expect(
          (yield* store.match(
            { attribute: ":worker/code" },
            {
              validAt: MAR_2,
              recordedAt: MAR_10,
            },
          ))
            .map((fact) => fact.value)
            .sort(),
        ).toEqual(["L-23", "M-17"]);
      }),
    );
  });
});
