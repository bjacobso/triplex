import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { EntityId, KvTriples, Triples } from "../../src/index.js";
import * as Attribute from "../../src/config/Attribute.js";
import * as EntityType from "../../src/config/EntityType.js";
import { KeyProvider, Sensitive, ValueCodec } from "../../src/sensitive/index.js";

const Site = EntityType.make("Site", { name: Attribute.text(":site/name") });
const Worker = EntityType.make("Worker", {
  name: Attribute.text(":worker/name").required(),
  score: Attribute.number(":worker/score"),
  count: Attribute.integer(":worker/count"),
  active: Attribute.boolean(":worker/active"),
  date: Attribute.date(":worker/date"),
  instant: Attribute.instant(":worker/instant"),
  status: Attribute.enumOf(":worker/status", ["active", "pending"]),
  site: Attribute.ref(":worker/site", Site),
  tags: Attribute.text(":worker/tag").many(),
  scores: Attribute.number(":worker/scores").many(),
  counts: Attribute.integer(":worker/counts").many(),
  flags: Attribute.boolean(":worker/flags").many(),
  dates: Attribute.date(":worker/dates").many(),
  instants: Attribute.instant(":worker/instants").many(),
  statuses: Attribute.enumOf(":worker/statuses", ["active", "pending"]).many(),
  sites: Attribute.ref(":worker/sites", Site).many(),
  missing: Attribute.text(":worker/missing"),
});
const id = EntityId.make("worker:maria");
const values = {
  name: "Maria",
  score: 1.5,
  count: 2,
  active: true,
  date: "2026-01-01",
  instant: 1000,
  status: "active" as const,
  site: EntityId.make("site:harbor"),
  tags: ["a", "b"],
  scores: [1.5, 2.5],
  counts: [1, 2],
  flags: [false, true],
  dates: ["2025-01-01", "2026-01-01"],
  instants: [1000, 2000],
  statuses: ["active", "pending"] as const,
  sites: [EntityId.make("site:harbor"), EntityId.make("site:port")],
};
const seed = Effect.gen(function* () {
  const db = yield* Triples;
  yield* db.transact(Worker.assert(id, values, { validFrom: 0 }));
  return yield* db.entity(id);
});

describe("EntityType.decode", () => {
  it("reserves the decode alias", () => {
    expect(() =>
      EntityType.make("Conflict", { decode: Attribute.text(":conflict/value") }),
    ).toThrow("reserved");
  });
  it.effect("round-trips every scalar kind and many values, with aliases and metadata", () =>
    Effect.gen(function* () {
      const facts = yield* seed;
      expect(yield* Worker.decode(facts)).toEqual({ ...values, missing: undefined });
      const decoded = yield* Worker.decode(facts, { withFacts: true });
      expect(decoded.values).toEqual({ ...values, missing: undefined });
      expect(decoded.facts.name[0]?.id).toBe(
        facts.find((f) => f.attribute === Worker.name.key)?.id,
      );
      expect(Worker.replace(decoded.facts.name[0]!, { name: "M" }, 10).ops).toHaveLength(3);
      expect(decoded.unknownFacts).toEqual([]);
    }).pipe(Effect.provide(KvTriples.layer)),
  );

  it.effect(
    "rejects duplicate scalar facts, missing required aliases and foreign subjects/types",
    () =>
      Effect.gen(function* () {
        const facts = yield* seed;
        const name = facts.find((f) => f.attribute === Worker.name.key)!;
        const cases = [
          { facts: [...facts, name], reason: "cardinality" },
          { facts: facts.filter((f) => f !== name), reason: "required" },
          {
            facts: [...facts, { ...name, entityId: EntityId.make("worker:other") }],
            reason: "entity",
          },
          { facts: [{ ...name, entityType: Option.some("Site") }], reason: "entityType" },
          { facts: [{ ...name, entityType: Option.none() }], reason: "entityType" },
        ];
        for (const item of cases) {
          expect(yield* Effect.flip(Worker.decode(item.facts))).toMatchObject({
            _tag: "EntityDecodeError",
            reason: item.reason,
          });
        }
        expect(yield* Effect.flip(Worker.decode([]))).toMatchObject({ reason: "required" });
        const partial = yield* Worker.decode([], { allowPartial: true });
        expect(partial.name).toBeUndefined();
        expect(partial.tags).toEqual([]);
      }).pipe(Effect.provide(KvTriples.layer)),
  );

  it.effect("requires nonempty required-many aliases and deduplicates and orders many values", () =>
    Effect.gen(function* () {
      const Many = EntityType.make("Many", {
        tags: Attribute.text(":many/tag").required({ cardinality: "many" }),
      });
      expect(yield* Effect.flip(Many.decode([]))).toMatchObject({
        reason: "required",
        alias: "tags",
      });
      const db = yield* Triples;
      const created = yield* db.transact(Many.assert(id, { tags: ["b", "a"] }));
      const facts = [...created.triples, created.triples[0]!];
      const decoded = yield* Many.decode(facts, { withFacts: true });
      expect(decoded.values).toEqual({ tags: ["a", "b"] });
      expect(decoded.facts.tags).toHaveLength(3);
      expect(yield* Many.decode([], { allowPartial: true })).toEqual({ tags: [] });
    }).pipe(Effect.provide(KvTriples.layer)),
  );

  it.effect("ignores unknown attributes by default and reports them with metadata", () =>
    Effect.gen(function* () {
      const facts = yield* seed;
      const unknown = { ...facts[0]!, attribute: Attribute.text(":worker/unknown").key };
      const decoded = yield* Worker.decode([...facts, unknown], { withFacts: true });
      expect(decoded.unknownFacts).toEqual([unknown]);
      expect(decoded.values).toEqual(yield* Worker.decode(facts));
      expect(
        yield* Effect.flip(Worker.decode([...facts, unknown], { unknownAttributes: "reject" })),
      ).toMatchObject({ reason: "unknownAttribute" });
    }).pipe(Effect.provide(KvTriples.layer)),
  );

  it.effect("validates stored kinds, enums, integers, dates and refs", () =>
    Effect.gen(function* () {
      const facts = yield* seed;
      for (const [alias, value] of [
        ["name", { type: "number", value: 1 }],
        ["count", { type: "number", value: 1.5 }],
        ["status", { type: "string", value: "unknown" }],
        ["date", { type: "string", value: "yesterday" }],
        ["site", { type: "ref", value: "" as EntityId }],
      ] as const) {
        const bad = facts.map((f) =>
          f.attribute === Worker.attributes[alias].key ? { ...f, value } : f,
        );
        expect(yield* Effect.flip(Worker.decode(bad))).toMatchObject({ reason: "value" });
      }
    }).pipe(Effect.provide(KvTriples.layer)),
  );

  it.effect("decodes a past validAt and normalizes Date inputs to epoch milliseconds", () =>
    Effect.gen(function* () {
      const db = yield* Triples;
      yield* db.transact(
        Worker.assert(id, { name: "Past", instant: new Date(1000) }, { validFrom: 0, validTo: 20 }),
      );
      yield* db.transact(Worker.assert(id, { name: "Present" }, { validFrom: 20 }));
      expect(
        yield* Worker.decode(yield* db.match({ entityId: id }, { validAt: 10 })),
      ).toMatchObject({ name: "Past", instant: 1000, tags: [] });
      expect(
        yield* Worker.decode(yield* db.match({ entityId: id }, { validAt: 30 })),
      ).toMatchObject({ name: "Present", instant: undefined });
    }).pipe(Effect.provide(KvTriples.layer)),
  );

  it.effect("returns only a sealed marker and refuses plaintext on sensitive attributes", () => {
    const Employee = EntityType.make("Employee", {
      secret: Attribute.sensitive(Attribute.text(":employee/secret")).required(),
    });
    const layer = Sensitive.layer({ database: "decode-test", attributes: [Employee] }).pipe(
      Layer.provide(ValueCodec.aesGcm.pipe(Layer.provide(KeyProvider.test({ seed: "decode" })))),
      Layer.provide(KvTriples.layer),
    );
    return Effect.gen(function* () {
      const db = yield* Triples;
      yield* db.transact(Employee.assert(id, { secret: "plaintext" }));
      const facts = yield* db.entity(id);
      const decoded = yield* Employee.decode(facts);
      expect(decoded.secret).toEqual({
        $sealed: { valueType: "string", keyId: expect.any(String) },
      });
      expect(JSON.stringify(decoded)).not.toContain("plaintext");
      expect(JSON.stringify(decoded)).not.toContain("ciphertext");
      const opened = yield* Sensitive.open(facts);
      expect(yield* Effect.flip(Employee.decode(opened))).toMatchObject({ reason: "value" });
      const Unmarked = EntityType.make("Employee", { secret: Attribute.text(":employee/secret") });
      expect(yield* Unmarked.decode(facts)).toEqual(decoded);
    }).pipe(Effect.provide(layer));
  });
});

it.effect("can count distinct scalar values while retaining strict defaults and source facts", () =>
  Effect.gen(function* () {
    const facts = yield* seed;
    const name = facts.find((fact) => fact.attribute === Worker.name.key)!;
    const duplicate = [...facts, { ...name, id: facts[1]!.id }];
    expect(yield* Effect.flip(Worker.decode(duplicate))).toMatchObject({ reason: "cardinality" });
    const decoded = yield* Worker.decode(duplicate, {
      scalarCardinality: "distinct",
      withFacts: true,
    });
    expect(decoded.values.name).toBe("Maria");
    expect(decoded.facts.name).toHaveLength(2);
    expect(
      yield* Effect.flip(
        Worker.decode([...facts, { ...name, value: { type: "string", value: "Other" } }], {
          scalarCardinality: "distinct",
        }),
      ),
    ).toMatchObject({ reason: "cardinality" });
    for (const blind of [undefined, "blind"]) {
      const value = {
        type: "sealed" as const,
        valueType: "string" as const,
        keyId: "key",
        ciphertext: "cipher",
        ...(blind === undefined ? {} : { blind }),
      };
      const sealed = facts.map((fact) => (fact === name ? { ...fact, value } : fact));
      const same = {
        ...name,
        value: { ...value, ...(blind === undefined ? {} : { ciphertext: "rotated" }) },
      };
      expect(
        (yield* Worker.decode([...sealed, same], { scalarCardinality: "distinct" })).name,
      ).toEqual({ $sealed: { valueType: "string", keyId: "key" } });
      const other = {
        ...name,
        value: {
          ...value,
          ciphertext: "other",
          ...(blind === undefined ? {} : { blind: "other" }),
        },
      };
      expect(
        yield* Effect.flip(Worker.decode([...sealed, other], { scalarCardinality: "distinct" })),
      ).toMatchObject({ reason: "cardinality" });
    }
  }).pipe(Effect.provide(KvTriples.layer)),
);

it.effect("can validate aggregate membership without requiring one subject or typed facts", () =>
  Effect.gen(function* () {
    const facts = yield* seed;
    const extra = {
      ...facts[0]!,
      attribute: Attribute.text(":worker/extra").key,
      entityId: EntityId.make("worker:other"),
      entityType: Option.none<string>(),
    };
    expect(yield* Effect.flip(Worker.decode([...facts, extra]))).toMatchObject({
      reason: "entity",
    });
    expect(yield* Worker.decode([...facts, extra], { factValidation: "membership" })).toEqual(
      yield* Worker.decode(facts),
    );
    expect(yield* Effect.flip(Worker.decode([], { factValidation: "membership" }))).toMatchObject({
      reason: "entityType",
      message: "Entity is not a Worker",
    });
    expect(
      yield* Effect.flip(
        Worker.decode([...facts, { ...extra, entityType: Option.some("Other") }], {
          factValidation: "membership",
        }),
      ),
    ).toMatchObject({
      reason: "entityType",
      message: "Mixed entity-type membership is not supported",
    });
  }).pipe(Effect.provide(KvTriples.layer)),
);

it.effect("keeps summary errors by default and can expose detailed value diagnostics", () =>
  Effect.gen(function* () {
    const facts = yield* seed;
    const bad = facts.map((fact) =>
      fact.attribute === Worker.count.key
        ? { ...fact, value: { type: "number" as const, value: 1.5 } }
        : fact,
    );
    expect(yield* Effect.flip(Worker.decode(bad))).toMatchObject({
      message: "Stored value does not satisfy the configured type",
      alias: "count",
    });
    expect(yield* Effect.flip(Worker.decode(bad, { valueDiagnostics: "detailed" }))).toMatchObject({
      message: "Stored value does not satisfy the configured type: Expected an integer",
      alias: "count",
    });
  }).pipe(Effect.provide(KvTriples.layer)),
);
