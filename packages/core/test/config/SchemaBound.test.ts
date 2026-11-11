import { expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import { KvTriples } from "../../src/kv/layers/KvTriplesLive.js";
import { EntityId } from "../../src/Branded.js";
import { Triples } from "../../src/store/Triples.js";
import * as Attribute from "../../src/config/Attribute.js";
import * as ConfigStore from "../../src/config/ConfigStore.js";
import * as SchemaBound from "../../src/config/SchemaBound.js";

const base = ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer));

it("checks every read, preserves known results, and follows moved refs", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* ConfigStore.ConfigStore;
      const raw = yield* Triples;
      const status = Attribute.text(":vendor/status");
      const statusNode = yield* status.node;
      const first = yield* store.commit({ label: "v1", objects: [statusNode], ref: "live" });
      expect(SchemaBound.attributeKeys(first.snapshot)).toEqual(new Set([":vendor/status"]));
      yield* raw.assert({
        entityId: EntityId.make("vendor:a"),
        attribute: status.key,
        value: { type: "string", value: "active" },
      });
      const good = { find: ["?e"], where: [["?e", ":vendor/status", "active"]] } as const;
      const bad = { find: ["?e"], where: [["?e", ":vendor/staus", "active"]] } as const;
      const expected = yield* raw.query(good);
      expect((yield* raw.query(bad)).results).toEqual([]);
      yield* Effect.gen(function* () {
        const bound = yield* Triples;
        expect((yield* bound.query(good)).results).toEqual(expected.results);
        const execute = vi.spyOn(raw, "query");
        const reads: readonly Effect.Effect<unknown, unknown>[] = [
          bound.query(bad),
          bound.queryAll(bad),
          bound.queryPage({ inner: bad }),
          bound.explain(bad),
          bound.explainPage({ inner: bad }),
        ];
        for (const read of reads) {
          expect(yield* Effect.flip(read)).toMatchObject({
            _tag: "UnknownAttributeError",
            key: ":vendor/staus",
            path: expect.stringContaining("where[0][1]"),
          });
        }
        expect(execute).not.toHaveBeenCalled();
        execute.mockRestore();
        expect(yield* Effect.flip(bound.match({ attribute: ":vendor/staus" }))).toMatchObject({
          _tag: "ReadError",
          cause: { _tag: "UnknownAttributeError", path: "match.attribute" },
        });
        expect((yield* bound.match({})).length).toBeGreaterThan(0);
        yield* store.commit({
          label: "v2",
          objects: [statusNode, yield* Attribute.text(":vendor/staus").node],
          ref: "live",
        });
        expect((yield* bound.query(bad)).results).toEqual([]);
      }).pipe(Effect.provide(SchemaBound.layer()));
    }).pipe(Effect.provide(base)),
  );
});
