import { describe, expect, it } from "vitest";
import { Effect, Option, Schema } from "effect";
import { EntityId, KvTriples, Triples, string } from "../src/index.js";
import { diagnose } from "../src/errors/diagnostic.js";
import { TransactRequest, TripleInput } from "../src/Triple.js";
import * as Attribute from "../src/config/Attribute.js";
import * as EntityType from "../src/config/EntityType.js";
import * as Change from "../src/Change.js";
import { validateDatalogQuery } from "../src/datalog/validation.js";

const status = Attribute.text(":integer/status");
const Vendor = EntityType.make("IntegerVendor", { status });
const input = {
  entityId: EntityId.make("integer:one"),
  attribute: status.key,
  value: string("yes"),
};
const code = "time.invalid-bound";
const throwsBound = (run: () => unknown) => {
  try {
    run();
    throw new Error("accepted fractional bound");
  } catch (error) {
    expect(diagnose(error).code).toBe(code);
  }
};

describe("integer valid-time bounds", () => {
  it("rejects fractional assertion and transaction schema bounds", () => {
    for (const field of ["validFrom", "validTo"]) {
      expect(Schema.is(TripleInput)({ ...input, [field]: 1.5 })).toBe(false);
      expect(
        Schema.is(TransactRequest)({ operations: [{ op: "assert", ...input, [field]: 1.5 }] }),
      ).toBe(false);
      throwsBound(() => Attribute.assertion(status, "yes", { [field]: 1.5 }));
      throwsBound(() => Vendor.assert(input.entityId, { status: "yes" }, { [field]: 1.5 }));
      throwsBound(() => Vendor.assert(input.entityId, {}, { [field]: 1.5 }));
    }
  });

  it("rejects fractional split points and copied fact bounds in Change verbs", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const t = yield* Triples;
        const fact = yield* t.assert({ ...input, validFrom: 1, validTo: 10 });
        throwsBound(() => Change.end(fact, 2.5));
        throwsBound(() => Change.replace(fact, string("next"), 2.5));
        for (const invalid of [
          { ...fact, validFrom: 1.5 },
          { ...fact, validTo: Option.some(10.5) },
        ]) {
          throwsBound(() => Change.end(invalid, 3));
          throwsBound(() => Change.replace(invalid, string("next"), 3));
          throwsBound(() => Change.correct(invalid, string("next")));
        }
      }).pipe(Effect.provide(KvTriples.layer)),
    );
  });

  it("gives fractional interval literals a typed diagnostic, including nested patterns", async () => {
    for (const valid of [{ from: 1.5 }, { to: 2.5 }]) {
      const pattern = { pattern: ["?e", status.key, "yes"], valid };
      for (const where of [
        [pattern],
        [
          ["?e", status.key, "yes"],
          ["not", pattern],
        ],
      ]) {
        const result = await Effect.runPromise(
          Effect.result(validateDatalogQuery({ find: ["?e"], where })),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(diagnose(result.failure).code).toBe(code);
      }
    }
  });
});
