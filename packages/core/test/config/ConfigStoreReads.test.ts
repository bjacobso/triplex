/**
 * The Triples-backed ConfigStore reads only what each operation needs and caches immutable
 * records. These tests pin it to the semantics of the pure store loaded in full.
 */

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { KvTriples } from "../../src/kv/layers/KvTriplesLive.js";
import { Triples, type TriplesService } from "../../src/store/Triples.js";
import * as ConfigNode from "../../src/config/ConfigNode.js";
import * as ConfigStore from "../../src/config/ConfigStore.js";
import * as InMemoryConfigStore from "../../src/config/InMemoryConfigStore.js";
import * as TypeExpr from "../../src/config/TypeExpr.js";

const Narrow = TypeExpr.struct({ label: TypeExpr.required(TypeExpr.text) });
// Accepts the same bodies, so committing a node under it extends `validUnder`.
const Wide = TypeExpr.struct({
  label: TypeExpr.required(TypeExpr.text),
  hint: TypeExpr.optional(TypeExpr.text),
});

const field = (label: string, type: TypeExpr.TypeExpr = Narrow) =>
  ConfigNode.makeTyped({ kind: "field", key: "name", type, attrs: { label } });

const form = (fieldNode: ConfigNode.ConfigNode, title: string) =>
  ConfigNode.make({
    kind: "form",
    key: "onboarding",
    attrs: { title },
    children: [{ rel: "field", node: fieldNode }],
    refs: [{ rel: "uses", kind: "policy", key: "p" }],
  });

const policy = (message: string) =>
  ConfigNode.make({ kind: "policy", key: "p", attrs: { message } });

/** Two ConfigStore instances over one Triples store, like two processes sharing a database. */
const makeStores = Effect.gen(function* () {
  const triples = yield* Triples;
  const instance = () =>
    Effect.service(ConfigStore.ConfigStore).pipe(
      Effect.provide(ConfigStore.layer.pipe(Layer.provide(Layer.succeed(Triples, triples)))),
    );
  return { triples, a: yield* instance(), b: yield* instance() };
});

/** Every ref and snapshot, as the whole-store load reconstructs them. */
const fromFullLoad = (store: ConfigStore.ConfigStoreService) =>
  Effect.gen(function* () {
    const loaded = yield* store.load();
    return {
      refs: [...loaded.refs.keys()].map((name) => [
        name,
        InMemoryConfigStore.resolveRef(loaded, name),
      ]),
      snapshots: loaded.snapshots,
    };
  });

const fromTargetedReads = (store: ConfigStore.ConfigStoreService, refs: readonly string[]) =>
  Effect.gen(function* () {
    const loaded = yield* store.load();
    return {
      refs: yield* Effect.forEach(refs, (name) =>
        store.resolveRef(name).pipe(Effect.map((snapshot) => [name, snapshot] as const)),
      ),
      snapshots: yield* Effect.forEach(loaded.snapshots, (snapshot) =>
        store.snapshotById(snapshot.id),
      ),
    };
  });

describe("ConfigStore targeted reads", () => {
  it.effect("commit the same releases as the pure store", () =>
    Effect.gen(function* () {
      const { a } = yield* makeStores;
      let pure = InMemoryConfigStore.empty();
      const releases = [
        [yield* field("Name"), "Welcome", "v1"],
        [yield* field("Name"), "Welcome!", "v1"],
        [yield* field("Full name"), "Welcome!", "v2"],
        [yield* field("Full name", Wide), "Welcome!", "v2"],
        [yield* field("Name"), "Welcome", "v1"],
      ] as const;
      for (const [index, [fieldNode, title, message]] of releases.entries()) {
        const objects = [yield* form(fieldNode, title), yield* policy(message)];
        const expected = yield* InMemoryConfigStore.commit(pure, { label: `r${index}`, objects });
        pure = expected.store;
        const actual = yield* a.commit({ label: `r${index}`, objects, ref: "live" });
        expect(actual.snapshot.id).toBe(expected.snapshot.id);
        expect(actual.snapshot.seq).toBe(expected.snapshot.seq);
        expect(actual.snapshot.parentId).toBe(expected.snapshot.parentId);
        expect(actual.created.map((revision) => revision.id)).toEqual(
          expected.created.map((revision) => revision.id),
        );
      }
      const loaded = yield* a.load();
      expect(loaded.revisions.map((revision) => revision.id)).toEqual(
        pure.revisions.map((revision) => revision.id),
      );
      expect([...loaded.objects.keys()].sort()).toEqual([...pure.objects.keys()].sort());
      expect([...loaded.schemas.keys()].sort()).toEqual([...pure.schemas.keys()].sort());
      expect(loaded.seq).toBe(pure.seq);
    }).pipe(Effect.provide(KvTriples.layer)),
  );

  it.effect("agree with the full load while another instance writes", () =>
    Effect.gen(function* () {
      const { a, b } = yield* makeStores;
      const first = yield* a.commit({
        label: "one",
        objects: [yield* form(yield* field("Name"), "Hi"), yield* policy("v1")],
        ref: "live",
      });
      expect(yield* fromTargetedReads(a, ["live"])).toEqual(yield* fromFullLoad(a));

      // Another writer: a new release and a ref move.
      const second = yield* b.commit({
        label: "two",
        objects: [yield* form(yield* field("Name"), "Hello"), yield* policy("v1")],
        ref: "test",
      });
      yield* b.setRef("live", second.snapshot.id);
      expect((yield* a.resolveRef("live"))?.id).toBe(second.snapshot.id);
      expect((yield* a.resolveRef("test"))?.id).toBe(second.snapshot.id);

      // Another writer proves an existing body valid under a new schema. Decoded nodes take
      // their type from `validUnder`, so cached trees must follow, as the full load does.
      yield* b.commit({
        label: "three",
        objects: [yield* form(yield* field("Name", Wide), "Hello"), yield* policy("v1")],
      });
      expect(yield* fromTargetedReads(a, ["live", "test"])).toEqual(yield* fromFullLoad(a));
      expect((yield* a.snapshotById(first.snapshot.id))?.root).toEqual(
        InMemoryConfigStore.snapshotById(yield* a.load(), first.snapshot.id)?.root,
      );

      expect(yield* a.resolveRef("missing")).toBeUndefined();
      expect(yield* a.snapshotById("sha256-missing" as never)).toBeUndefined();
      const unknown = yield* a.setRef("live", "sha256-missing" as never).pipe(Effect.flip);
      expect(unknown._tag).toBe("UnknownSnapshotError");
    }).pipe(Effect.provide(KvTriples.layer)),
  );

  it.effect("don't scan the store to resolve a ref", () =>
    Effect.gen(function* () {
      const inner = yield* Triples;
      const typeScans: string[] = [];
      const counting: TriplesService = {
        ...inner,
        match: (pattern, basis) => {
          if (pattern.entityType !== undefined && pattern.entityId === undefined) {
            typeScans.push(pattern.entityType);
          }
          return inner.match(pattern, basis);
        },
      };
      const store = yield* Effect.service(ConfigStore.ConfigStore).pipe(
        Effect.provide(ConfigStore.layer.pipe(Layer.provide(Layer.succeed(Triples, counting)))),
      );
      yield* store.commit({
        label: "one",
        objects: [yield* form(yield* field("Name"), "Hi"), yield* policy("v1")],
        ref: "live",
      });
      typeScans.length = 0;
      expect(yield* store.resolveRef("live")).toBeDefined();
      expect(yield* store.resolveRef("live")).toBeDefined();
      expect(yield* store.reverseDependencies({ kind: "policy", key: "p" })).toHaveLength(1);
      expect(typeScans).toEqual([]);
    }).pipe(Effect.provide(KvTriples.layer)),
  );
});
