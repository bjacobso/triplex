import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { KvTriples } from "../../src/kv/layers/KvTriplesLive.js";
import { Triples } from "../../src/store/Triples.js";
import { EntityId } from "../../src/Branded.js";
import { string } from "../../src/Value.js";
import * as Attribute from "../../src/config/Attribute.js";
import * as ConfigStore from "../../src/config/ConfigStore.js";
import * as Derivation from "../../src/derivation/Derivation.js";
import { KeyProvider, Sensitive, ValueCodec } from "../../src/sensitive/index.js";
import { Why, type WhySubject } from "../../src/why/index.js";

const Secret = Attribute.sensitive(Attribute.text(":worker/secret"));
const codec = Layer.effect(
  ValueCodec.ValueCodec,
  Effect.gen(function* () {
    const original = yield* ValueCodec.ValueCodec;
    return { ...original, open: () => Effect.die("why must never open a sealed value") };
  }),
).pipe(
  Layer.provide(ValueCodec.aesGcm.pipe(Layer.provide(KeyProvider.test({ seed: "why-test" })))),
);
const Store = Sensitive.layer({ database: "why-test", attributes: [Secret] }).pipe(
  Layer.provide(codec),
  Layer.provide(KvTriples.layer),
);
const Services = Why.layer.pipe(
  Layer.provideMerge(ConfigStore.layer.pipe(Layer.provideMerge(Store))),
);
it.effect("keeps sensitive assertion and candidate sources sealed through decorators", () =>
  Effect.gen(function* () {
    const t = yield* Triples;
    const why = yield* Why;
    const planted = "917-55-4321";
    const written = yield* t.transact([
      {
        op: "assert",
        entityId: EntityId.make("worker:secret"),
        attribute: Secret.key,
        value: string(planted),
        validFrom: 100,
      },
    ]);
    const basis = { recordedPosition: written.position, validAt: 150 };
    const definition = yield* Derivation.make({
      name: "sensitive-source",
      query: { find: ["?worker"], where: [["?worker", Secret.key, planted]] },
      identity: ["?worker"],
      configSnapshot: "release:legacy",
    });
    const candidate = (yield* Derivation.evaluate(t, definition, { basis })).candidates[0]!;
    const explanation = yield* why.why(
      { kind: "candidate", definition, candidateId: candidate.id, revision: candidate.revision },
      { basis },
    );
    expect(explanation.facts).toHaveLength(1);
    expect(explanation.facts[0]!.value.type).toBe("sealed");
    expect(JSON.stringify(explanation)).not.toContain(planted);
    yield* t.transact([{ op: "retract", id: written.triples[0]!.id }]);
    expect(yield* t.get(written.triples[0]!.id)).toBeNull();
    expect((yield* t.assertion(written.triples[0]!.id))?.value.type).toBe("sealed");
    const retired = yield* why.why(
      { kind: "fact", tripleId: written.triples[0]!.id },
      { basis: { validAt: 150 } },
    );
    expect(retired.facts[0]!.value.type).toBe("sealed");
    expect(JSON.stringify(retired)).not.toContain(planted);
  }).pipe(Effect.provide(Services)),
);

it.effect("retains the sensitive policy when only Why is exposed by the host layer", () => {
  // Setup and policy services are deliberately private to the host's layer.
  class Prepared extends Context.Service<
    Prepared,
    { subject: WhySubject; basis: { validAt: number; recordedPosition: number } }
  >()("why/test/Prepared") {}
  const setup = Layer.effect(
    Prepared,
    Effect.gen(function* () {
      const t = yield* Triples;
      const write = yield* t.transact([
        {
          op: "assert",
          entityId: EntityId.make("worker:hidden-policy"),
          attribute: Secret.key,
          value: string("private-equality"),
          validFrom: 100,
        },
      ]);
      const basis = { validAt: 150, recordedPosition: write.position };
      const definition = yield* Derivation.make({
        name: "hidden-policy",
        query: { find: ["?worker"], where: [["?worker", Secret.key, "private-equality"]] },
        identity: ["?worker"],
        configSnapshot: "legacy",
      });
      const candidate = (yield* Derivation.evaluate(t, definition, { basis })).candidates[0]!;
      return {
        basis,
        subject: {
          kind: "candidate" as const,
          definition,
          candidateId: candidate.id,
          revision: candidate.revision,
        },
      };
    }),
  );
  const host = Layer.merge(Why.layer, setup).pipe(
    Layer.provide(ConfigStore.layer.pipe(Layer.provideMerge(Store))),
  );
  return Effect.gen(function* () {
    const why = yield* Why;
    const prepared = yield* Prepared;
    const explanation = yield* why.why(prepared.subject, { basis: prepared.basis });
    expect(explanation.facts).toHaveLength(1);
    expect(explanation.facts[0]!.value.type).toBe("sealed");
    expect(JSON.stringify(explanation)).not.toContain("private-equality");
  }).pipe(Effect.provide(host));
});
