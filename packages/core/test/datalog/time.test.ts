import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { assertDatalogQuery } from "../../src/datalog/validation.js";
import { preparePagination } from "../../src/Pagination.js";
import { KvTriples } from "../../src/kv/layers/KvTriplesLive.js";
import { Triples } from "../../src/store/Triples.js";
import { KvBackend } from "../../src/kv/kv/KvBackend.js";
import { makeTestKvBackend } from "../../src/kv/kv/InMemoryKvBackend.js";
import { DeterministicTripleStoreRuntimeLive } from "../../src/store/TripleStoreRuntime.js";

const interval = { pattern: ["?e", ":status", "active"], valid: { from: "?from", to: "?to" } };
describe("Datalog valid intervals", () => {
  it("accepts interval bindings and null predicate operands", () => {
    expect(
      assertDatalogQuery({ find: ["?from", "?to"], where: [interval, ["!=", "?to", null]] }).where,
    ).toHaveLength(2);
  });
  it("rejects malformed bounds, incompatible identities, and all-time optional projection", () => {
    for (const valid of [
      {},
      { from: -1 },
      { to: Infinity },
      { from: "2026-01-01" },
      { from: "?bad-name" },
      { from: 10, to: 9 },
      { from: 10, to: 10 },
      { extra: "?x" },
    ]) {
      expect(() => assertDatalogQuery({ find: ["?e"], where: [{ ...interval, valid }] })).toThrow();
    }
    expect(() =>
      assertDatalogQuery({ find: ["?e"], where: [{ ...interval, valid: { from: "?e" } }] }),
    ).toThrow();
    expect(() =>
      assertDatalogQuery({
        validTime: "all",
        find: ["?e", "?x"],
        where: [["?e", ":status", "active"]],
        optionalProjection: { rowBinding: "?e", fields: [{ attribute: ":x", variable: "?x" }] },
      }),
    ).toThrow();
  });
  it("does not capture a valid point for all-time pagination", () => {
    const query = {
      inner: { validTime: "all", find: ["?e"], where: [["?e", ":status", "active"]] },
    } as const;
    expect(
      preparePagination({ query, now: 100, recordedPosition: 3, scope: "test" }).basis.validAt,
    ).toBeUndefined();
  });
  it("projects stored bounds, keeps point membership, and joins backdated provenance", async () => {
    const layer = KvTriples.layerBackend.pipe(
      Layer.provide(Layer.sync(KvBackend, makeTestKvBackend)),
      Layer.provide(DeterministicTripleStoreRuntimeLive({ now: 100 })),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const receipt = yield* triples.transact(
          [
            {
              op: "assert",
              entityId: "e:one",
              attribute: ":status",
              value: { type: "string", value: "active" },
              validFrom: 10,
              validTo: 20,
            },
            {
              op: "assert",
              entityId: "e:one",
              attribute: ":status",
              value: { type: "string", value: "active" },
              validFrom: 30,
            },
          ],
          { actor: "user:pat" },
        );
        const query = {
          validTime: "all",
          find: ["?from", "?to"],
          where: [interval],
          orderBy: [{ variable: "?from" }],
        } as const;
        expect((yield* triples.queryAll(query)).results).toEqual([
          { "?from": 10, "?to": 20 },
          { "?from": 30, "?to": null },
        ]);
        expect(
          (yield* triples.queryAll({ ...query, validTime: "point" }, { basis: { validAt: 15 } }))
            .results,
        ).toEqual([{ "?from": 10, "?to": 20 }]);
        const provenance = yield* triples.queryAll(
          {
            find: ["?actor"],
            where: [
              ["?e", ":status", "active", "?tx"],
              ["?tx", ":_tx/actor", "?actor"],
            ],
          },
          { basis: { recordedPosition: receipt.position, validAt: 15 } },
        );
        expect(provenance.results).toEqual([{ "?actor": "user:pat" }]);
      }).pipe(Effect.provide(layer)),
    );
  });
});

import { compile } from "../../src/datalog/compiler.js";
it("compiles interval projections and parameterized recorded-only metadata visibility", () => {
  const query = {
    validTime: "all",
    find: ["?from", "?to"],
    where: [interval, ["!=", "?to", null], ["<=", "?to", 50]],
  } as const;
  const compiled = compile(query, undefined, false, { basis: { recordedPosition: 3 } });
  expect(compiled.sql).toContain("valid_to");
  expect(compiled.sql).toContain("valid_from");
  expect(compiled.params).toContain(3);
  expect(compiled.params).toContain(50);
});

import { attributesOf } from "../../src/datalog/attributes.js";
import { extractDependencies } from "../../src/subscriptions/extract-dependencies.js";
import { prepareQuery } from "../../src/sensitive/analysis.js";
it("traverses interval attributes for schema and dependency checks", () => {
  const query = { find: ["?e"], where: [interval] } as const;
  expect(attributesOf(query)).toEqual(new Set([":status"]));
  expect(extractDependencies(query).attributes).toEqual(new Set([":status"]));
});
it("rewrites sensitive interval constants and rejects sealed bound aliases", async () => {
  const policy = {
    attributes: new Map([[":status", "string" as const]]),
    blindScope: "attribute" as const,
    blind: () => Effect.succeed("token"),
  };
  const prepared = await Effect.runPromise(
    prepareQuery(policy, { find: ["?from"], where: [interval] }),
  );
  expect(prepared.where[0]).toEqual({
    ...interval,
    pattern: ["?e", ":status", { type: "blind", value: "token" }],
  });
  await expect(
    Effect.runPromise(
      prepareQuery(policy, {
        find: ["?end"],
        where: [{ pattern: ["?e", ":status", "?end"], valid: { to: "?end" } }],
      }),
    ),
  ).rejects.toMatchObject({ _tag: "SensitiveQueryError" });
});

it("explains interval range keys and residual visibility", async () => {
  const plan = await Effect.runPromise(
    Effect.gen(function* () {
      const t = yield* Triples;
      return yield* t.explain({
        find: ["?to"],
        where: [{ pattern: ["?e", ":expiry", "?v"], valid: { to: "?to" } }, ["<=", "?to", 50]],
      });
    }).pipe(Effect.provide(KvTriples.layer)),
  );
  expect(plan.queryPlan.steps[0]?.query).toContain("attribute-valid-to");
  expect(plan.queryPlan.steps[0]?.query).toContain("recorded visibility");
});

import * as Derivation from "../../src/derivation/Derivation.js";
import { Schema } from "effect";
import { IntervalPattern } from "../../src/datalog/schema.js";
it("closes interval schemas and rejects interval/all-time provenance definitions", async () => {
  expect(() =>
    Schema.decodeUnknownSync(IntervalPattern)({ ...interval, surprise: true }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(IntervalPattern)({
      ...interval,
      valid: { to: "?end", surprise: true },
    }),
  ).toThrow();
  for (const query of [
    { find: ["?e"], where: [interval] },
    { validTime: "all", find: ["?e"], where: [["?e", ":status", "active"]] },
  ] as const) {
    await expect(
      Effect.runPromise(
        Derivation.make({ name: "interval", configSnapshot: "test", identity: ["?e"], query }),
      ),
    ).rejects.toMatchObject({ _tag: "DerivationDefinitionError" });
  }
});

it("rejects an explicit all-time validAt inside commit read views", async () => {
  const layer = KvTriples.layer;
  await Effect.runPromise(
    Effect.gen(function* () {
      const t = yield* Triples;
      const rejected: unknown[] = [];
      yield* t.transact([], {
        validate: [
          {
            name: "time-view",
            validate: (commit) =>
              Effect.gen(function* () {
                const outcome = yield* Effect.result(
                  commit.before.query(
                    { validTime: "all", find: ["?e"], where: [["?e", ":view/test", "?v"]] },
                    { validAt: 10 },
                  ),
                );
                rejected.push(outcome._tag);
              }),
          },
        ],
      });
      expect(rejected).toEqual(["Failure"]);
    }).pipe(Effect.provide(layer)),
  );
});

it("pins all-time pages across equal-timestamp commits and tied finite/null bounds", async () => {
  const layer = KvTriples.layerBackend.pipe(
    Layer.provide(Layer.sync(KvBackend, makeTestKvBackend)),
    Layer.provide(DeterministicTripleStoreRuntimeLive({ now: 100 })),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const t = yield* Triples;
      const receipt = yield* t.transact(
        Array.from({ length: 8 }, (_, i) => ({
          op: "assert" as const,
          entityId: `page:${i < 4 ? "z" : "a"}:${i % 4}`,
          attribute: ":page/time",
          value: { type: "string" as const, value: "active" },
          validFrom: 10000,
          ...(i < 4 ? { validTo: 20000 } : {}),
        })),
      );
      const query = {
        validTime: "all",
        find: ["?e", "?end"],
        where: [{ pattern: ["?e", ":page/time", "active"], valid: { to: "?end" } }],
        orderBy: [{ variable: "?end" }],
      } as const;
      const first = yield* t.query(query, {
        pageSize: 2,
        basis: { recordedPosition: receipt.position },
      });
      const replacement = yield* t.transact([
        { op: "retract", id: receipt.triples[6]!.id },
        {
          op: "assert",
          entityId: "page:new",
          attribute: ":page/time",
          value: { type: "string", value: "active" },
          validFrom: 30000,
        },
      ]);
      expect(receipt.instant).toBe(replacement.instant);
      const results = [...first.results];
      let cursor = first.nextCursor;
      while (cursor) {
        const page = yield* t.query(query, { pageSize: 2, cursor });
        results.push(...page.results);
        cursor = page.nextCursor;
      }
      expect(results.map((row) => row["?e"])).toEqual([
        "page:z:0",
        "page:z:1",
        "page:z:2",
        "page:z:3",
        "page:a:0",
        "page:a:1",
        "page:a:2",
        "page:a:3",
      ]);
    }).pipe(Effect.provide(layer)),
  );
});

import { Stream } from "effect";
it("captures a recorded cut before asynchronous all-time scans", async () => {
  const backend = makeTestKvBackend();
  const {
    getSync: _getSync,
    getRangeSync: _rangeSync,
    setAllStr: _setStr,
    ...asyncBackend
  } = backend;
  let duringRead: (() => Effect.Effect<void>) | undefined;
  const hooked = {
    ...asyncBackend,
    getRange: (options: Parameters<typeof backend.getRange>[0]) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (options.start[0] === 2 && duringRead) {
            const write = duringRead;
            duringRead = undefined;
            yield* write();
          }
          return backend.getRange(options);
        }),
      ),
  };
  const layer = KvTriples.layerBackend.pipe(
    Layer.provide(Layer.succeed(KvBackend, hooked)),
    Layer.provide(DeterministicTripleStoreRuntimeLive({ now: 100 })),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.transact([
        {
          op: "assert",
          entityId: "cut:one",
          attribute: ":cut/status",
          value: { type: "string", value: "old" },
          validFrom: 1,
        },
      ]);
      duringRead = () =>
        t
          .transact([
            {
              op: "assert",
              entityId: "cut:two",
              attribute: ":cut/status",
              value: { type: "string", value: "new" },
              validFrom: 1,
            },
          ])
          .pipe(Effect.orDie, Effect.asVoid);
      const result = yield* t.queryAll({
        validTime: "all",
        find: ["?value"],
        where: [["?e", ":cut/status", "?value"]],
      });
      expect(result.results).toEqual([{ "?value": "old" }]);
    }).pipe(Effect.provide(layer)),
  );
});
