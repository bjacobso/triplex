import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import * as Errors from "../src/errors/index.js";
import { diagnose, type Diagnostic, KvTriples, Triples, type DatalogQuery } from "../src/index.js";
import { checkAttributes } from "../src/datalog/attributes.js";
import * as Attribute from "../src/config/Attribute.js";
import { Sensitive, ValueCodec, KeyProvider } from "../src/sensitive/index.js";

const badQuery = (query: unknown) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const triples = yield* Triples;
      return diagnose(yield* Effect.flip(triples.query(query as DatalogQuery)));
    }).pipe(Effect.provide(KvTriples.layer)),
  );
const check = (diagnostic: Diagnostic, code: string, path?: string, retryable = false) => {
  expect(diagnostic).toMatchObject({ code, retryable, fix: expect.any(String) });
  expect(diagnostic.path).toBe(path);
  expect(JSON.parse(JSON.stringify(diagnostic))).toEqual(diagnostic);
};

it.each([
  [{ find: ["?e"], where: [["and", ["?e", ":a", true]]] }, "datalog.and-clause", "where[0]"],
  [
    { find: ["?e"], where: [["not", ["and", ["?e", ":a", true]]]] },
    "datalog.not-with-and",
    "where[0]",
  ],
  [
    {
      find: ["?e"],
      where: [
        [
          "or",
          [
            [
              ["?e", ":a", true],
              ["?e", ":b", true],
            ],
          ],
        ],
      ],
    },
    "datalog.or-branch-not-single-clause",
    "where[0] alternative 0",
  ],
  [{ find: false, where: [] }, "datalog.invalid-shape", "$"],
  [{ find: ["?missing"], where: [["?e", ":a", "?v"]] }, "datalog.unbound-variable", "find"],
  [
    {
      find: ["?e"],
      where: [
        ["?e", ":a", "?v"],
        [">", "?v", "text"],
      ],
    },
    "datalog.invalid-predicate",
    "where[1]",
  ],
  [
    { find: ["?e"], where: [["?e", ":a", "?v"]], aggregate: [["count", "?v", "?n"]] },
    "datalog.invalid-aggregate",
    "aggregate[0]",
  ],
  [{ find: ["?e", "?e"], where: [["?e", ":a", "?v"]] }, "datalog.invalid-projection", "find"],
])("diagnoses a bad public query: %s", async (query, code, path) => {
  check(await badQuery(query), code as string, path as string);
});

it("diagnoses unknown attributes with their suggested spelling", async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      checkAttributes(
        { find: ["?e"], where: [["?e", ":vendor/staus", true]] },
        new Set([":vendor/status"]),
      ),
    ),
  );
  const diagnostic = diagnose(error);
  check(diagnostic, "schema.unknown-attribute", "where[0][1]");
  expect(diagnostic.fix).toContain(":vendor/status");
});

it("diagnoses real constraint, precondition and duplicate command failures", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const t = yield* Triples;
      const constraint = diagnose(
        yield* Effect.flip(
          t.transact(
            [
              {
                op: "assert",
                entityId: "p",
                entityType: "Person",
                attribute: ":age",
                value: { type: "number", value: 1 },
                validFrom: 100,
              },
            ],
            {
              enforce: {
                constraints: [{ _tag: "Required", v: 1, entityType: "Person", attribute: ":name" }],
              },
            },
          ),
        ),
      );
      check(constraint, "constraint.violation", '$[":name"]');
      expect(constraint.details).toEqual({
        violations: [{ constraintKey: "Person::name:required", subject: "p", validAt: 100 }],
      });
      expect(constraint.fix).toContain("interval");
      const fact = yield* t.assert({
        entityId: "p",
        attribute: ":age",
        value: { type: "number", value: 1 },
      });
      yield* t.transact([{ op: "retract", id: fact.id }], { commandId: "once" });
      check(
        diagnose(
          yield* Effect.flip(
            t.transact([{ op: "retract", id: fact.id }], {
              preconditions: [{ _tag: "TripleLive", id: fact.id }],
            }),
          ),
        ),
        "transaction.conflict.precondition",
        undefined,
        true,
      );
      const duplicate = diagnose(yield* Effect.flip(t.transact([], { commandId: "once" })));
      check(duplicate, "transaction.command-already-committed");
      expect(duplicate.fix).toContain("transactionByCommand");
    }).pipe(Effect.provide(KvTriples.layer)),
  );
});

it.each(["serialization", "deadlock"] as const)("distinguishes %s conflicts", (reason) => {
  check(
    diagnose(new Errors.TransactionConflictError({ reason, message: "conflict" })),
    `transaction.conflict.${reason}`,
    undefined,
    true,
  );
});

it("never includes plaintext or causes from sensitive queries", async () => {
  const layer = Sensitive.layer({
    database: "test",
    attributes: [Attribute.sensitive(Attribute.text(":test/secret"))],
  }).pipe(
    Layer.provide(ValueCodec.aesGcm.pipe(Layer.provide(KeyProvider.test({ seed: "diagnostics" })))),
    Layer.provide(KvTriples.layer),
  );
  const diagnostic = await Effect.runPromise(
    Effect.gen(function* () {
      const t = yield* Triples;
      return diagnose(
        yield* Effect.flip(
          t.query({
            find: ["?v"],
            where: [
              ["?e", ":test/secret", "?v"],
              ["!=", "?v", "planted-plaintext"],
            ],
          }),
        ),
      );
    }).pipe(Effect.provide(layer)),
  );
  check(diagnostic, "sensitive.query");
  expect(JSON.stringify(diagnostic)).not.toContain("planted-plaintext");
  expect(diagnostic.details).toBeUndefined();
});

it("maps every exported error class and rejects unknown inputs", () => {
  for (const ErrorClass of Object.values(Errors)) {
    // Empty fixtures exercise the default mapping independently of payload details.
    const error = new (ErrorClass as new (args: object) => Error)({
      database: "test",
      message: "test",
    });
    expect(diagnose(error).code, ErrorClass.name).not.toBe("internal");
  }
  for (const error of [
    null,
    undefined,
    "oops",
    new Error("oops"),
    { _tag: "WriteError", message: "forged" },
  ]) {
    expect(diagnose(error)).toMatchObject({ code: "internal", retryable: false });
  }
});
