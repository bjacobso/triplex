import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import {
  Change,
  EntityId,
  KvTriples,
  TransactionConflictError,
  Triples,
  string,
} from "../src/index.js";
import type { Triple, TransactAssertOp } from "../src/Triple.js";
import * as Attribute from "../src/config/Attribute.js";
import * as ConfigStore from "../src/config/ConfigStore.js";
import * as EntityType from "../src/config/EntityType.js";
import * as GraphConstraint from "../src/config/GraphConstraint.js";
import { Sensitive, ValueCodec } from "../src/sensitive/index.js";

const Vendor = EntityType.make("Vendor", {
  status: Attribute.text(":vendor/status").required(),
  name: Attribute.text(":vendor/name"),
  tags: Attribute.text(":vendor/tag").many(),
});
const vendor = EntityId.make("vendor:acme");
const seed: TransactAssertOp = {
  op: "assert",
  entityId: vendor,
  entityType: "Vendor",
  attribute: ":vendor/status",
  value: string("prospect"),
  validFrom: 10,
  validTo: 30,
};
const create = Effect.gen(function* () {
  const triples = yield* Triples;
  const result = yield* triples.transact([seed]);
  return result.triples[0]!;
});

describe("Change", () => {
  it.effect("produces exactly the handwritten ops and guards for every verb", () =>
    Effect.gen(function* () {
      const fact = yield* create;
      const retract = { op: "retract", id: fact.id };
      const guard = { _tag: "TripleLive", id: fact.id };
      const past = { ...seed, validTo: 20 };
      const next = { ...seed, value: string("active"), validFrom: 20 };
      expect(Change.end(fact, 20)).toEqual({ ops: [retract, past], preconditions: [guard] });
      expect(Change.replace(fact, string("active"), 20)).toEqual({
        ops: [retract, past, next],
        preconditions: [guard],
      });
      expect(Change.correct(fact, string("active"))).toEqual({
        ops: [retract, { ...seed, value: string("active") }],
        preconditions: [guard],
      });
      const end = Change.end(fact, 20);
      const correct = Change.correct(fact, string("active"));
      expect(Change.combine(end, correct)).toEqual({
        ops: [...end.ops, ...correct.ops],
        preconditions: [guard, guard],
      });
      expect(Change.combine()).toEqual({ ops: [], preconditions: [] });
    }).pipe(Effect.provide(KvTriples.layer)),
  );

  it.effect("omits absent bounds and entity types instead of inventing them", () =>
    Effect.gen(function* () {
      const fact = yield* create;
      const open: Triple = { ...fact, entityType: Option.none(), validTo: Option.none() };
      const { entityType: _type, validTo: _to, ...untyped } = seed;
      expect(Change.correct(open, string("active")).ops[1]).toEqual({
        ...untyped,
        value: string("active"),
      });
      expect(Change.replace(open, string("active"), 20).ops[2]).toEqual({
        ...untyped,
        value: string("active"),
        validFrom: 20,
      });
    }).pipe(Effect.provide(KvTriples.layer)),
  );

  it.effect("rejects invalid end/replace instants with a typed RangeError", () =>
    Effect.gen(function* () {
      const fact = yield* create;
      for (const at of [0, 9, 10, 30, 31, NaN, Infinity, -Infinity]) {
        for (const build of [
          () => Change.end(fact, at),
          () => Change.replace(fact, string("active"), at),
        ]) {
          expect(build).toThrow(Change.ChangeRangeError);
          expect(build).toThrow(RangeError);
        }
      }
      expect(() => Change.end({ ...fact, validTo: Option.none() }, 100)).not.toThrow();
    }).pipe(Effect.provide(KvTriples.layer)),
  );

  for (const verb of ["end", "replace", "correct", "combine"] as const) {
    it.effect(`${verb} preserves the intended values across valid time`, () =>
      Effect.gen(function* () {
        const triples = yield* Triples;
        const fact = yield* create;
        const change =
          verb === "end"
            ? Change.end(fact, 20)
            : verb === "replace"
              ? Change.replace(fact, string("active"), 20)
              : verb === "correct"
                ? Change.correct(fact, string("active"))
                : Change.combine(Change.replace(fact, string("active"), 20), {
                    ops: [{ ...seed, attribute: ":vendor/name", value: string("Acme") }],
                    preconditions: [],
                  });
        yield* triples.transact(change.ops, { preconditions: change.preconditions });
        const valuesAt = (validAt: number) =>
          Effect.map(
            triples.match({ entityId: vendor, attribute: seed.attribute }, { validAt }),
            (facts) => facts.map((f) => f.value),
          );
        expect(yield* valuesAt(9)).toEqual([]);
        expect(yield* valuesAt(10)).toEqual([string(verb === "correct" ? "active" : "prospect")]);
        expect(yield* valuesAt(19)).toEqual([string(verb === "correct" ? "active" : "prospect")]);
        expect(yield* valuesAt(20)).toEqual(verb === "end" ? [] : [string("active")]);
        expect(yield* valuesAt(29)).toEqual(verb === "end" ? [] : [string("active")]);
        expect(yield* valuesAt(30)).toEqual([]);
        expect(
          (yield* triples.history(vendor)).some(
            (f) => f.id === fact.id && Option.isSome(f.retractedAt),
          ),
        ).toBe(true);
      }).pipe(Effect.provide(KvTriples.layer)),
    );
  }

  it.effect("rejects a stale read atomically through the generated TripleLive guard", () =>
    Effect.gen(function* () {
      const triples = yield* Triples;
      const fact = yield* create;
      const stale = Change.replace(fact, string("cancelled"), 20);
      const concurrent = Change.correct(fact, string("active"));
      yield* triples.transact(concurrent.ops, concurrent);
      const error = yield* triples.transact(stale.ops, stale).pipe(Effect.flip);
      expect(error).toBeInstanceOf(TransactionConflictError);
      expect(
        (yield* triples.match({ entityId: vendor }, { validAt: 25 })).map((f) => f.value),
      ).toEqual([string("active")]);
    }).pipe(Effect.provide(KvTriples.layer)),
  );

  it.effect("replaces a required cardinality-one value under pinned enforcement", () =>
    Effect.gen(function* () {
      const triples = yield* Triples;
      const config = yield* ConfigStore.ConfigStore;
      const release = yield* config.commit({
        label: "vendor",
        objects: yield* Vendor.nodes,
        ref: "live",
      });
      const pinned = yield* GraphConstraint.pinned(release.snapshot);
      const result = yield* triples.transact(
        Vendor.assert(vendor, { status: "prospect" }, { validFrom: 10 }),
        pinned,
      );
      const change = Vendor.replace(result.triples[0]!, { status: "active" }, 20);
      yield* triples.transact(change.ops, { ...pinned, preconditions: change.preconditions });
      for (const validAt of [10, 19, 20, 21, 100]) {
        const facts = yield* triples.match(
          { entityId: vendor, attribute: seed.attribute },
          { validAt },
        );
        expect(facts.map((f) => f.value)).toEqual([string(validAt < 20 ? "prospect" : "active")]);
      }
    }).pipe(Effect.provide(ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer)))),
  );

  it.effect("encodes typed aliases, operates on single many-values, and checks ownership", () =>
    Effect.gen(function* () {
      const fact = yield* create;
      expect(Vendor.end(fact, 20)).toEqual(Change.end(fact, 20));
      expect(Vendor.replace(fact, { status: "active" }, 20)).toEqual(
        Change.replace(fact, string("active"), 20),
      );
      expect(Vendor.correct(fact, { status: "active" })).toEqual(
        Change.correct(fact, string("active")),
      );
      const tag = { ...fact, attribute: Vendor.tags.key };
      expect(Vendor.correct(tag, { tags: "new" })).toEqual(Change.correct(tag, string("new")));
      expect(() => Vendor.replace(fact, { name: "Acme" }, 20)).toThrow(TypeError);
      expect(() => Vendor.end({ ...fact, entityType: Option.some("Other") }, 20)).toThrow(
        TypeError,
      );
      expect(() => Vendor.end({ ...fact, entityType: Option.none() }, 20)).toThrow(TypeError);
      expect(() =>
        Vendor.end({ ...fact, attribute: Attribute.text(":other/status").key }, 20),
      ).toThrow(TypeError);
      expect(() => EntityType.make("Clash", { replace: Attribute.text(":clash/value") })).toThrow(
        /reserved/,
      );
    }).pipe(Effect.provide(KvTriples.layer)),
  );

  it.effect("keeps sealed ciphertext when ending and takes plaintext for correction", () =>
    Effect.gen(function* () {
      const triples = yield* Triples;
      const sealed = {
        type: "sealed",
        valueType: "string",
        keyId: "test",
        ciphertext: "opaque",
      } as const;
      const result = yield* triples.transact([{ ...seed, value: sealed }]);
      const fact = result.triples[0]!;
      const end = Change.end(fact, 20);
      expect(end.ops[1]).toEqual({ ...seed, value: sealed, validTo: 20 });
      expect(Change.correct(fact, string("corrected")).ops[1]).toEqual({
        ...seed,
        value: string("corrected"),
      });
      yield* triples.transact(end.ops, end);
      expect(
        (yield* triples.match({ entityId: vendor }, { validAt: 19 })).map((f) => f.value),
      ).toEqual([sealed]);
    }).pipe(Effect.provide(KvTriples.layer)),
  );

  it.effect("corrects a sealed fact with plaintext through the sensitive write layer", () => {
    const Secret = EntityType.make("Secret", {
      status: Attribute.sensitive(Attribute.text(":secret/status")),
    });
    return Effect.gen(function* () {
      const triples = yield* Triples;
      const result = yield* triples.transact(
        Secret.assert(vendor, { status: "wrong" }, { validFrom: 10, validTo: 30 }),
      );
      const fact = result.triples[0]!;
      expect(fact.value.type).toBe("sealed");
      const correction = Secret.correct(fact, { status: "corrected" });
      yield* triples.transact(correction.ops, correction);
      const facts = yield* triples.match({ entityId: vendor }, { validAt: 20 });
      expect(facts[0]?.value.type).toBe("sealed");
      const opened = yield* Sensitive.open(facts);
      expect(opened.map((f) => f.value)).toEqual([string("corrected")]);
      expect(facts[0]?.validFrom).toBe(10);
      expect(facts[0]?.validTo).toEqual(Option.some(30));
    }).pipe(
      Effect.provide(
        Sensitive.layer({ database: "change-test", attributes: [Secret] }).pipe(
          Layer.provide(ValueCodec.identity),
          Layer.provide(KvTriples.layer),
        ),
      ),
    );
  });

  it.effect("documents the existing sensitive-layer blocker for reasserting sealed pasts", () => {
    const Secret = EntityType.make("Secret", {
      status: Attribute.sensitive(Attribute.text(":secret/status")),
    });
    return Effect.gen(function* () {
      const triples = yield* Triples;
      const result = yield* triples.transact(
        Secret.assert(vendor, { status: "secret" }, { validFrom: 10 }),
      );
      const fact = result.triples[0]!;
      for (const change of [Secret.end(fact, 20), Secret.replace(fact, { status: "new" }, 20)]) {
        const error = yield* triples.transact(change.ops, change).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "WriteError",
          cause: { _tag: "SensitiveValueError", reason: "sealed-input" },
        });
      }
      expect(
        (yield* triples.match({ entityId: vendor }, { validAt: 25 })).map((f) => f.id),
      ).toEqual([fact.id]);
    }).pipe(
      Effect.provide(
        Sensitive.layer({ database: "change-test", attributes: [Secret] }).pipe(
          Layer.provide(ValueCodec.identity),
          Layer.provide(KvTriples.layer),
        ),
      ),
    );
  });
});
