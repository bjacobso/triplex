import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";

import {
  Constraint,
  ConstraintViolationError,
  KvTriples,
  Triples,
  type Triple,
  type TripleId,
} from "../src/index.js";

const rules: readonly Constraint.Rule[] = [
  { _tag: "Required", v: 1, entityType: "Person", attribute: ":person/name" },
  { _tag: "Cardinality", v: 1, entityType: "Person", attribute: ":person/name", max: 1 },
  { _tag: "Unique", v: 1, entityType: "Person", attribute: ":person/email" },
  {
    _tag: "ReferenceTarget",
    v: 1,
    entityType: "Person",
    attribute: ":person/employer",
    targetEntityType: "Employer",
  },
];

const enforced = { enforce: { constraints: rules }, configSnapshot: "sha256:test-release" };

const run = <A, E>(effect: Effect.Effect<A, E, Triples>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(KvTriples.layer)));

const fact = (input: {
  readonly id: string;
  readonly entityId: string;
  readonly entityType: string;
  readonly attribute: string;
}): Triple => ({
  id: input.id as Triple["id"],
  entityId: input.entityId as Triple["entityId"],
  entityType: Option.some(input.entityType),
  attribute: input.attribute as Triple["attribute"],
  value: { type: "string", value: "fixture" },
  recordedAt: 1,
  validFrom: 1,
  validTo: Option.none(),
  createdBy: Option.none(),
  retractedAt: Option.none(),
  schemaVersion: Option.none(),
  txId: Option.none(),
  retractTxId: Option.none(),
});

describe("transaction graph constraints", () => {
  it("loads only constrained subjects and reference target types", async () => {
    const typeCalls: string[] = [];
    const entityCalls: string[][] = [];
    const existing = fact({
      id: "existing-type",
      entityId: "person:existing",
      entityType: "Person",
      attribute: ":person/name",
    });
    const loaded = await Effect.runPromise(
      Constraint.loadRelevantFacts(
        rules,
        [
          {
            op: "assert",
            entityId: "person:new",
            entityType: "Person",
            attribute: ":person/name",
            value: { type: "string", value: "New" },
          },
        ],
        {
          byEntityType: (entityType) =>
            Effect.sync(() => {
              typeCalls.push(entityType);
              return entityType === "Person" ? [existing] : [];
            }),
          byEntities: (entityIds) =>
            Effect.sync(() => {
              entityCalls.push([...entityIds]);
              return [existing];
            }),
        },
      ),
    );

    expect(typeCalls.sort()).toEqual(["Employer", "Person"]);
    expect(entityCalls).toEqual([["person:existing", "person:new"]]);
    expect(loaded).toEqual([existing]);
  });

  it("rejects violations atomically with a typed error", async () => {
    const result = await run(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const before = yield* triples.currentPosition();
        const error = yield* triples
          .transact(
            [
              {
                op: "assert",
                entityId: "person:missing-name",
                entityType: "Person",
                attribute: ":person/email",
                value: { type: "string", value: "person@example.com" },
              },
            ],
            enforced,
          )
          .pipe(Effect.flip);
        return {
          before,
          after: yield* triples.currentPosition(),
          facts: yield* triples.match({ entityId: "person:missing-name" }),
          error,
        };
      }),
    );

    expect(result.error).toBeInstanceOf(ConstraintViolationError);
    expect(result.error).toMatchObject({
      violations: [expect.objectContaining({ code: "required", subject: "person:missing-name" })],
    });
    expect(result.error.message).toMatch(
      /^Transaction would introduce or worsen 1 graph constraint violation: Person::person\/name:required for person:missing-name at validAt \d{4}-\d{2}-\d{2}T[^ ]+Z \(Person requires :person\/name\)$/,
    );
    expect(result.facts).toEqual([]);
    expect(result.after).toBe(result.before);
  });

  it("enforces cardinality, uniqueness, and reference targets over the post-state", async () => {
    const result = await run(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const seeded = yield* triples.transact(
          [
            {
              op: "assert",
              entityId: "employer:acme",
              entityType: "Employer",
              attribute: ":employer/name",
              value: { type: "string", value: "Acme" },
            },
            ...["one", "two"].flatMap((suffix) => [
              {
                op: "assert" as const,
                entityId: `person:${suffix}`,
                entityType: "Person",
                attribute: ":person/name",
                value: { type: "string" as const, value: suffix },
              },
              {
                op: "assert" as const,
                entityId: `person:${suffix}`,
                entityType: "Person",
                attribute: ":person/email",
                value: { type: "string" as const, value: `${suffix}@example.com` },
              },
              {
                op: "assert" as const,
                entityId: `person:${suffix}`,
                entityType: "Person",
                attribute: ":person/employer",
                value: { type: "ref" as const, value: "employer:acme" },
              },
            ]),
          ],
          enforced,
        );

        const duplicate = yield* triples
          .transact(
            [
              {
                op: "assert",
                entityId: "person:two",
                entityType: "Person",
                attribute: ":person/email",
                value: { type: "string", value: "one@example.com" },
              },
            ],
            enforced,
          )
          .pipe(Effect.flip);
        const cardinality = yield* triples
          .transact(
            [
              {
                op: "assert",
                entityId: "person:one",
                entityType: "Person",
                attribute: ":person/name",
                value: { type: "string", value: "Another name" },
              },
            ],
            enforced,
          )
          .pipe(Effect.flip);
        const target = yield* triples
          .transact(
            [
              {
                op: "assert",
                entityId: "person:one",
                entityType: "Person",
                attribute: ":person/employer",
                value: { type: "ref", value: "employer:missing" },
              },
            ],
            enforced,
          )
          .pipe(Effect.flip);
        const targetRetraction = yield* triples
          .transact([{ op: "retract", id: seeded.triples[0]!.id }], enforced)
          .pipe(Effect.flip);
        return { duplicate, cardinality, target, targetRetraction };
      }),
    );

    expect(result.duplicate).toMatchObject({
      violations: expect.arrayContaining([expect.objectContaining({ code: "unique" })]),
    });
    expect(result.cardinality).toMatchObject({
      violations: [expect.objectContaining({ code: "cardinality", actual: 2 })],
    });
    expect(result.target).toMatchObject({
      violations: [expect.objectContaining({ code: "reference-target" })],
    });
    expect(result.targetRetraction).toMatchObject({
      violations: expect.arrayContaining([expect.objectContaining({ code: "reference-target" })]),
    });
  });

  it("checks every future valid-time boundary and permits non-overlapping claims", async () => {
    const result = await run(
      Effect.gen(function* () {
        const triples = yield* Triples;
        yield* triples.transact(
          ["one", "two"].flatMap((suffix) => [
            {
              op: "assert" as const,
              entityId: `person:${suffix}`,
              entityType: "Person",
              attribute: ":person/name",
              value: { type: "string" as const, value: suffix },
              validFrom: 100,
              validTo: 300,
            },
            {
              op: "assert" as const,
              entityId: `person:${suffix}`,
              entityType: "Person",
              attribute: ":person/email",
              value: { type: "string" as const, value: "shared@example.com" },
              validFrom: suffix === "one" ? 100 : 200,
              validTo: suffix === "one" ? 200 : 300,
            },
          ]),
          enforced,
        );
        const overlap = yield* triples
          .transact(
            [
              {
                op: "assert",
                entityId: "person:three",
                entityType: "Person",
                attribute: ":person/name",
                value: { type: "string", value: "three" },
                validFrom: 150,
                validTo: 250,
              },
              {
                op: "assert",
                entityId: "person:three",
                entityType: "Person",
                attribute: ":person/email",
                value: { type: "string", value: "shared@example.com" },
                validFrom: 150,
                validTo: 250,
              },
            ],
            enforced,
          )
          .pipe(Effect.flip);
        return overlap;
      }),
    );

    expect(result).toMatchObject({
      violations: expect.arrayContaining([
        expect.objectContaining({ code: "unique", validAt: 150 }),
        expect.objectContaining({ code: "unique", validAt: 200 }),
      ]),
    });
  });

  it("allows an unrelated write beside legacy violations and allows repair", async () => {
    await run(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const seeded = yield* triples.assertBatch([
          {
            entityId: "person:legacy-one",
            entityType: "Person",
            attribute: ":person/email",
            value: { type: "string", value: "duplicate@example.com" },
          },
          {
            entityId: "person:legacy-two",
            entityType: "Person",
            attribute: ":person/email",
            value: { type: "string", value: "duplicate@example.com" },
          },
        ]);
        yield* triples.transact(
          [
            {
              op: "assert",
              entityId: "employer:unrelated",
              entityType: "Employer",
              attribute: ":employer/name",
              value: { type: "string", value: "Unrelated" },
            },
          ],
          enforced,
        );
        yield* triples.transact([{ op: "retract", id: seeded[1]!.id as TripleId }], enforced);
      }),
    );
  });

  it("retains retracted facts' boundaries when detecting a widened invalid interval", async () => {
    const error = await run(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const seeded = yield* triples.assertBatch([
          {
            entityId: "person:interval",
            entityType: "Person",
            attribute: ":person/email",
            value: { type: "string", value: "interval@example.com" },
            validFrom: 0,
            validTo: 300,
          },
          {
            entityId: "person:interval",
            entityType: "Person",
            attribute: ":person/name",
            value: { type: "string", value: "Interval" },
            validFrom: 100,
            validTo: 200,
          },
        ]);
        return yield* triples
          .transact([{ op: "retract", id: seeded[1]!.id }], enforced)
          .pipe(Effect.flip);
      }),
    );

    expect(error).toMatchObject({
      violations: expect.arrayContaining([
        expect.objectContaining({ code: "required", validAt: 100 }),
      ]),
    });
  });

  it("names the first violations, with valid time, in the error message", () => {
    const violation = (subject: string, validAt: number): Constraint.ViolationAt => ({
      constraintKey: "Person::person/name:required",
      code: "required",
      subject,
      entityType: "Person",
      attribute: ":person/name",
      path: ":person/name",
      message: "Person requires :person/name",
      actual: 0,
      validAt,
    });
    const day = Date.UTC(2026, 2, 15);

    expect(Constraint.describeViolations([])).toBe(
      "Transaction would introduce or worsen 0 graph constraint violations",
    );
    expect(Constraint.describeViolations([violation("person:a", day)])).toBe(
      "Transaction would introduce or worsen 1 graph constraint violation: " +
        "Person::person/name:required for person:a at validAt 2026-03-15T00:00:00.000Z " +
        "(Person requires :person/name)",
    );
    expect(
      Constraint.describeViolations([
        violation("person:a", day),
        violation("person:b", day),
        violation("person:c", day),
      ]),
    ).toBe(
      "Transaction would introduce or worsen 3 graph constraint violations: " +
        "Person::person/name:required for person:a at validAt 2026-03-15T00:00:00.000Z " +
        "(Person requires :person/name); " +
        "Person::person/name:required for person:b at validAt 2026-03-15T00:00:00.000Z " +
        "(Person requires :person/name); and 1 more (see error.violations)",
    );
  });
});
