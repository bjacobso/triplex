import { describe, expect, it } from "vitest";
import { resolveTemporalBasis } from "../src/Temporal.js";
import { Effect, Layer, Option } from "effect";
import { EntityId } from "../src/Branded.js";
import { Triples } from "../src/store/Triples.js";
import { KvTriples } from "../src/kv/layers/KvTriplesLive.js";
import { KvBackend } from "../src/kv/kv/KvBackend.js";
import { makeTestKvBackend } from "../src/kv/kv/InMemoryKvBackend.js";
import { DeterministicTripleStoreRuntimeLive } from "../src/store/TripleStoreRuntime.js";
import { prepareEntityPage, encodeEntityPageCursor } from "../src/EntityPage.js";

describe("public commit-position basis", () => {
  it("pins entity pages to the requested cut and binds continuation to it", () => {
    const first = prepareEntityPage({
      request: { entityType: "Test", basis: { recordedPosition: 2 } },
      now: 100,
      recordedPosition: 9,
      scope: "test",
    });
    expect(first.basis).toEqual({ recordedPosition: 2, validAt: 100 });
    const cursor = encodeEntityPageCursor(first, "a");
    expect(
      prepareEntityPage({
        request: { entityType: "Test", cursor, basis: { recordedPosition: 2 } },
        now: 200,
        recordedPosition: 10,
        scope: "test",
      }).basis,
    ).toEqual(first.basis);
    expect(() =>
      prepareEntityPage({
        request: { entityType: "Test", cursor, basis: { recordedPosition: 3 } },
        now: 200,
        recordedPosition: 10,
        scope: "test",
      }),
    ).toThrow("different temporal basis");
  });

  it("separates commits sharing one millisecond, including a retraction and replacement", async () => {
    const layer = KvTriples.layerBackend.pipe(
      Layer.provide(Layer.sync(KvBackend, makeTestKvBackend)),
      Layer.provide(DeterministicTripleStoreRuntimeLive({ now: 100 })),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const first = yield* triples.transact([
          {
            op: "assert",
            entityId: "same:tick",
            entityType: "SameTick",
            attribute: ":version",
            value: { type: "string", value: "old" },
          },
        ]);
        const second = yield* triples.transact([
          { op: "retract", id: first.triples[0]!.id },
          {
            op: "assert",
            entityId: "same:tick",
            entityType: "SameTick",
            attribute: ":version",
            value: { type: "string", value: "new" },
          },
        ]);
        expect(first.instant).toBe(second.instant);
        const basis = { recordedPosition: first.position };
        const facts = yield* triples.entity(EntityId.make("same:tick"), basis);
        expect(facts.map((fact) => fact.value)).toEqual([{ type: "string", value: "old" }]);
        expect(facts[0]!.retractedAt).toEqual(Option.none());
        expect(facts[0]!.retractTxId).toEqual(Option.none());
        const history = yield* triples.history(EntityId.make("same:tick"));
        expect(history.find((fact) => fact.id === first.triples[0]!.id)!.retractedAt).toEqual(
          Option.some(100),
        );
        const page = yield* triples.queryPage(
          { inner: { find: ["?value"], where: [["same:tick", ":version", "?value"]] } },
          { basis },
        );
        expect(page.results).toEqual([{ "?value": "old" }]);
        const entities = yield* triples.entityPage({ entityType: "SameTick", basis });
        expect(entities.entities.flat().map((fact) => fact.value)).toEqual([
          { type: "string", value: "old" },
        ]);
      }).pipe(Effect.provide(layer)),
    );
  });
  it("preserves an exact position, including the empty cut", () => {
    expect(resolveTemporalBasis({ recordedPosition: 7, validAt: 10 }, 20)).toEqual({
      recordedPosition: 7,
      validAt: 10,
    });
    expect(resolveTemporalBasis({ recordedPosition: 0 }, 20)).toEqual({
      recordedPosition: 0,
      validAt: 20,
    });
  });

  it.each([-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid position %s",
    (recordedPosition) => {
      expect(() => resolveTemporalBasis({ recordedPosition }, 20)).toThrow("recordedPosition");
    },
  );

  it("rejects ambiguous timestamp and position requests", () => {
    expect(() => resolveTemporalBasis({ recordedAt: 10, recordedPosition: 7 }, 20)).toThrow(
      "recordedAt and recordedPosition",
    );
  });
});
