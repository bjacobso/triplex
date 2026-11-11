import { expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { Change, EntityId, Triples, string } from "@triplex-build/triplex";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";
import { Attribute, EntityType } from "@triplex-build/triplex/config";
import { KeyProvider, Sensitive, ValueCodec } from "@triplex-build/triplex/sensitive";

for (const sensitive of [false, true]) {
  it(`replaces a ${sensitive ? "sealed" : "plaintext"} SQLite fact and preserves both interval boundaries`, async () => {
    const status = Attribute.text(":vendor/status");
    const Vendor = EntityType.make("Vendor", {
      status: sensitive ? Attribute.sensitive(status) : status,
    });
    const layer = Sensitive.layer({ database: "sqlite-change", attributes: [Vendor] }).pipe(
      Layer.provide(
        ValueCodec.aesGcm.pipe(Layer.provide(KeyProvider.test({ seed: "sqlite-change" }))),
      ),
      Layer.provide(SqliteTriples.layerMemory),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const entityId = EntityId.make("vendor:acme");
        const created = yield* triples.transact(
          Vendor.assert(entityId, { status: "prospect" }, { validFrom: 10, validTo: 30 }),
        );
        const fact = created.triples[0]!;
        const change = Change.replace(fact, string("active"), 20);
        yield* triples.transact(change.ops, change);
        for (const validAt of [10, 19, 20, 29]) {
          const facts = yield* triples.match({ entityId }, { validAt });
          const opened = sensitive ? yield* Sensitive.open(facts) : facts;
          expect(opened.map((f) => f.value)).toEqual([
            string(validAt < 20 ? "prospect" : "active"),
          ]);
          expect(facts[0]?.entityType).toEqual(Option.some("Vendor"));
          expect(facts[0]?.validFrom).toBe(validAt < 20 ? 10 : 20);
          expect(facts[0]?.validTo).toEqual(Option.some(validAt < 20 ? 20 : 30));
          if (sensitive) expect(facts[0]?.value.type).toBe("sealed");
        }
        expect(yield* triples.match({ entityId }, { validAt: 9 })).toEqual([]);
        expect(yield* triples.match({ entityId }, { validAt: 30 })).toEqual([]);
        expect(
          (yield* triples.history(entityId)).find((f) => f.id === fact.id)?.retractedAt,
        ).toSatisfy(Option.isSome);
      }).pipe(Effect.provide(layer)),
    );
  });
}
