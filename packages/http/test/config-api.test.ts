import {
  Attribute,
  EntityType,
  EntityValidation,
  InMemoryConfigStore,
  TypeExpr,
} from "@bjacobso/triplex/config";
import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";

import { compile } from "../src/ConfigApi.js";
import { compileHttpApi } from "../src/EntityHttpApi.js";
import { HandlerCache } from "../src/HandlerCache.js";
import * as HandlerCacheModule from "../src/HandlerCache.js";

const snapshot = Effect.gen(function* () {
  const Name = Attribute.text(":employer/name");
  const Tags = Attribute.text(":employer/tag");
  const Employer = EntityType.make("Employer", {
    attributes: {
      name: Attribute.use(Name, { required: true }),
      tags: Attribute.use(Tags, { cardinality: "many" }),
    },
  });
  return (yield* InMemoryConfigStore.commit(InMemoryConfigStore.empty(), {
    label: "v1",
    objects: yield* Employer.nodes,
  })).snapshot;
});

describe("ConfigApi", () => {
  it("compiles deterministic runtime schemas and OpenAPI from persisted nodes", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const release = yield* snapshot;
        const descriptor = yield* compile(release, {
          collections: { Employer: "employers" },
        });
        return {
          descriptor,
          contract: compileHttpApi(descriptor, { basePath: "/api", version: "v1" }),
        };
      }),
    );

    expect(result.descriptor.entities[0]).toMatchObject({
      entityType: "Employer",
      collection: "employers",
      attributes: [
        { key: ":employer/name", alias: "name", cardinality: "one" },
        { key: ":employer/tag", alias: "tags", cardinality: "many" },
      ],
    });
    expect(Object.keys(result.contract.openApi.paths)).toEqual([
      "/api/rest/v1/schema",
      "/api/rest/v1/openapi.json",
      "/api/rest/v1/employers",
      "/api/rest/v1/employers/{id}",
    ]);
    expect(result.contract.openApi.paths["/api/rest/v1/employers"]?.post).toBeDefined();

    const readOnly = compileHttpApi(result.descriptor, {
      basePath: "/api",
      version: result.descriptor.snapshotId,
      writable: false,
    });
    expect(readOnly.openApi.paths["/api/rest/v1/employers"]?.post).toBeUndefined();
  });

  it("rejects direct entity schemas without complete DSL usage metadata", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const node = yield* EntityValidation.define(
          "Incomplete",
          TypeExpr.struct({ ":incomplete/name": TypeExpr.required(TypeExpr.text) }),
        );
        const release = yield* InMemoryConfigStore.commit(InMemoryConfigStore.empty(), {
          label: "unsupported",
          objects: [node],
        });
        return yield* Effect.result(compile(release.snapshot));
      }),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure._tag).toBe("UnsupportedConfigError");
  });

  it("preserves shared keyword identities and validates exposure overrides", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const SharedName = Attribute.text(":shared/name");
        const Alpha = EntityType.make("Alpha", {
          attributes: { primaryName: Attribute.use(SharedName) },
        });
        const Beta = EntityType.make("Beta", {
          attributes: { displayName: Attribute.use(SharedName) },
        });
        const allNodes = yield* Effect.all([Alpha.nodes, Beta.nodes]);
        const nodes = [
          ...new Map(
            allNodes.flat().map((node) => [`${node.kind}\u0000${node.key}`, node]),
          ).values(),
        ];
        const release = yield* InMemoryConfigStore.commit(InMemoryConfigStore.empty(), {
          label: "shared",
          objects: nodes,
        });
        const descriptor = yield* compile(release.snapshot);
        const collision = yield* Effect.result(
          compile(release.snapshot, {
            collections: { Alpha: "things", Beta: "things" },
          }),
        );
        const unknown = yield* Effect.result(
          compile(release.snapshot, { collections: { Missing: "missing" } }),
        );
        return { descriptor, collision, unknown };
      }),
    );

    expect(result.descriptor.entities.map((entity) => entity.attributes[0])).toEqual([
      expect.objectContaining({ key: ":shared/name", alias: "primaryName" }),
      expect.objectContaining({ key: ":shared/name", alias: "displayName" }),
    ]);
    expect(Result.isFailure(result.collision)).toBe(true);
    expect(Result.isFailure(result.unknown)).toBe(true);
  });
});

describe("HandlerCache", () => {
  it("deduplicates concurrent builds and keeps a bounded LRU", async () => {
    let builds = 0;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const cache = yield* HandlerCache;
        const build = Effect.sync(() => ++builds);
        const values = yield* Effect.all(
          [cache.get("same", build), cache.get("same", build), cache.get("same", build)],
          { concurrency: "unbounded" },
        );
        yield* cache.get("second", Effect.succeed(2));
        yield* cache.get("third", Effect.succeed(3));
        return { values, size: yield* cache.size };
      }).pipe(Effect.provide(HandlerCacheModule.layer(2))),
    );

    expect(result).toEqual({ values: [1, 1, 1], size: 2 });
    expect(builds).toBe(1);
  });
});
