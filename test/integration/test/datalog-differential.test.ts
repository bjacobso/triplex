import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import {
  boolean,
  datetime,
  json,
  KvTriples,
  number,
  ref as makeRef,
  string,
  Triples,
  type DatalogQuery,
  type QueryContext,
} from "@bjacobso/triplex/internal";
import { EntityId } from "@bjacobso/triplex";
import { SqliteTriples } from "@bjacobso/triplex-sqlite";
import { ConfigStore, EntityValidation, TypeExpr } from "@bjacobso/triplex/config";

const eid = EntityId.make;
const ref = (value: string) => makeRef(eid(value));

const corpus: readonly DatalogQuery[] = [
  {
    find: ["?entity", "?code", "?count", "?enabled", "?instant", "?data", "?owner"],
    where: [
      ["?entity", ":diff/code", "?code"],
      ["?entity", ":diff/count", "?count"],
      ["?entity", ":diff/enabled", "?enabled"],
      ["?entity", ":diff/instant", "?instant"],
      ["?entity", ":diff/data", "?data"],
      ["?entity", ":diff/owner", "?owner"],
    ],
  },
  {
    find: ["?left", "?right", "?value"],
    where: [
      ["?left", ":diff/left", "?value"],
      ["?right", ":diff/right", "?value"],
    ],
  },
  {
    find: ["?entity", "?value"],
    where: [
      ["?entity", ":diff/equality", "?value"],
      ["=", "?value", 7],
    ],
  },
  {
    find: ["?entity", "?value"],
    where: [
      ["?entity", ":diff/equality", "?value"],
      ["!=", "?value", 7],
    ],
  },
  {
    find: ["?entity", "?value"],
    where: [
      ["?entity", ":diff/equality", "?value"],
      [">", "?value", 7],
    ],
  },
  {
    find: ["?entity", "?value"],
    where: [
      ["?entity", ":diff/equality", "?value"],
      ["not", ["?excluded", ":diff/excluded", "?value"]],
    ],
  },
  {
    find: ["?entity"],
    where: [["?entity", ":diff/enabled", true]],
  },
  {
    find: ["?dependent"],
    where: [
      ["diff:root", ":diff/child", "?child"],
      ["?dependent", ":diff/child", "?child"],
    ],
  },
  {
    find: ["?entity", "?code", "?count"],
    where: [["?entity", ":_schema/type", "DifferentialThing"]],
    optionalProjection: {
      rowBinding: "?entity",
      fields: [
        { attribute: ":diff/optional-code", variable: "?code" },
        { attribute: ":diff/optional-count", variable: "?count" },
      ],
    },
  },
];

const normalizeRows = (rows: readonly QueryContext[]): readonly string[] =>
  rows
    .map((row) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(row).sort(([left], [right]) => left.localeCompare(right)),
        ),
      ),
    )
    .sort();

const runCorpus = Effect.gen(function* () {
  const triples = yield* Triples;
  yield* triples.assertBatch([
    { entityId: eid("42"), attribute: ":diff/code", value: string("007") },
    { entityId: eid("42"), attribute: ":diff/count", value: number(7) },
    { entityId: eid("42"), attribute: ":diff/enabled", value: boolean(true) },
    { entityId: eid("42"), attribute: ":diff/instant", value: datetime(1_700_000_000_000) },
    { entityId: eid("42"), attribute: ":diff/data", value: json({ ok: true }) },
    { entityId: eid("42"), attribute: ":diff/owner", value: ref("7") },
    { entityId: eid("diff:left:number"), attribute: ":diff/left", value: number(7) },
    { entityId: eid("diff:right:number"), attribute: ":diff/right", value: number(7) },
    { entityId: eid("diff:left:string"), attribute: ":diff/left", value: string("7") },
    { entityId: eid("diff:right:string"), attribute: ":diff/right", value: string("7") },
    { entityId: eid("diff:right:other"), attribute: ":diff/right", value: number(8) },
    { entityId: eid("diff:eq:number"), attribute: ":diff/equality", value: number(7) },
    { entityId: eid("diff:eq:datetime"), attribute: ":diff/equality", value: datetime(7) },
    { entityId: eid("diff:eq:string"), attribute: ":diff/equality", value: string("7") },
    { entityId: eid("diff:eq:other"), attribute: ":diff/equality", value: number(8) },
    { entityId: eid("diff:excluded"), attribute: ":diff/excluded", value: number(7) },
    { entityId: eid("diff:root"), attribute: ":diff/child", value: ref("diff:leaf") },
    { entityId: eid("diff:sibling"), attribute: ":diff/child", value: ref("diff:leaf") },
    {
      entityId: eid("diff:optional"),
      attribute: ":_schema/type",
      value: string("DifferentialThing"),
    },
    { entityId: eid("diff:optional"), attribute: ":diff/optional-code", value: string("007") },
    { entityId: eid("diff:optional"), attribute: ":diff/optional-count", value: number(7) },
  ]);

  return yield* Effect.forEach(corpus, (query) =>
    Effect.gen(function* () {
      const expected = yield* triples.queryAll(query);
      const rows: QueryContext[] = [];
      let cursor: string | undefined;
      do {
        const page = yield* triples.query(query, {
          pageSize: 1,
          ...(cursor === undefined ? {} : { cursor }),
        });
        rows.push(...page.results);
        cursor = page.nextCursor;
        expect(rows.length).toBeLessThanOrEqual(expected.results.length);
      } while (cursor !== undefined);
      expect(normalizeRows(rows)).toEqual(normalizeRows(expected.results));
      return normalizeRows(rows);
    }),
  );
});

const runWith = (layer: Layer.Layer<Triples, unknown, never>) =>
  Effect.runPromise(runCorpus.pipe(Effect.provide(layer)));

describe("Datalog backend differential corpus", () => {
  it("returns identical typed bindings from KV and SQLite", async () => {
    const [kv, sqlite] = await Promise.all([
      runWith(KvTriples.layer),
      runWith(SqliteTriples.layerMemory),
    ]);

    expect(sqlite).toEqual(kv);
  });

  it("evaluates joins and recursive rules at one historical basis", async () => {
    const program = Effect.gen(function* () {
      const triples = yield* Triples;
      const initial = yield* triples.assertBatch([
        { entityId: eid("person:alice"), attribute: ":person/name", value: string("Alice") },
        { entityId: eid("person:alice"), attribute: ":person/team", value: ref("team:eng") },
        { entityId: eid("team:eng"), attribute: ":team/name", value: string("Engineering") },
        { entityId: eid("person:alice"), attribute: ":person/parent", value: ref("person:bob") },
        { entityId: eid("person:bob"), attribute: ":person/parent", value: ref("person:charlie") },
      ]);
      const asOf = initial[0]!.recordedAt;
      yield* Effect.sleep("5 millis");
      yield* triples.transact([
        { op: "retract", id: initial[0]!.id },
        { op: "retract", id: initial[4]!.id },
        {
          op: "assert",
          entityId: eid("person:alice"),
          attribute: ":person/name",
          value: string("Alicia"),
        },
        {
          op: "assert",
          entityId: eid("person:bob"),
          attribute: ":person/parent",
          value: ref("person:dana"),
        },
      ]);

      const joined: DatalogQuery = {
        find: ["?name", "?teamName"],
        where: [
          ["?person", ":person/name", "?name"],
          ["?person", ":person/team", "?team"],
          ["?team", ":team/name", "?teamName"],
        ],
      };
      const ancestors: DatalogQuery = {
        find: ["?ancestor"],
        where: [["ancestor", "person:alice", "?ancestor"]],
        rules: [
          {
            name: "ancestor",
            body: [["?person", ":person/parent", "?ancestor"]],
          },
          {
            name: "ancestor",
            body: [
              ["?person", ":person/parent", "?parent"],
              ["ancestor", "?parent", "?ancestor"],
            ],
          },
        ],
      };

      const historicalJoin = yield* triples.query(joined, {
        basis: { recordedAt: asOf, validAt: asOf },
      });
      const currentJoin = yield* triples.query(joined);
      const historicalAncestors = yield* triples.query(ancestors, {
        basis: { recordedAt: asOf, validAt: asOf },
      });
      const currentAncestors = yield* triples.query(ancestors);
      return {
        historicalJoin: normalizeRows(historicalJoin.results),
        currentJoin: normalizeRows(currentJoin.results),
        historicalAncestors: normalizeRows(historicalAncestors.results),
        currentAncestors: normalizeRows(currentAncestors.results),
      };
    });

    const runTemporal = (layer: Layer.Layer<Triples, unknown, never>) =>
      Effect.runPromise(program.pipe(Effect.provide(layer)));
    const [kv, sqlite] = await Promise.all([
      runTemporal(KvTriples.layer),
      runTemporal(SqliteTriples.layerMemory),
    ]);

    expect(sqlite).toEqual(kv);
    expect(kv.historicalJoin).toEqual([
      JSON.stringify({ "?name": "Alice", "?teamName": "Engineering" }),
    ]);
    expect(kv.currentJoin).toEqual([
      JSON.stringify({ "?name": "Alicia", "?teamName": "Engineering" }),
    ]);
    expect(kv.historicalAncestors).toEqual([
      JSON.stringify({ "?ancestor": "person:bob" }),
      JSON.stringify({ "?ancestor": "person:charlie" }),
    ]);
    expect(kv.currentAncestors).toEqual([
      JSON.stringify({ "?ancestor": "person:bob" }),
      JSON.stringify({ "?ancestor": "person:dana" }),
    ]);
  });

  it("reports identical checkpointed validation freshness on KV and SQLite", async () => {
    const program = Effect.gen(function* () {
      const triples = yield* Triples;
      const config = yield* ConfigStore.ConfigStore;
      const validation = yield* EntityValidation.EntityValidation;
      const schema = yield* EntityValidation.define(
        "Employee",
        TypeExpr.struct({
          ":employee/name": TypeExpr.required(TypeExpr.text),
          ":employee/age": TypeExpr.required(TypeExpr.integer),
        }),
      );
      yield* config.commit({ label: "employee schema", objects: [schema], ref: "live" });
      yield* triples.transact([
        {
          op: "assert",
          entityId: eid("employee:alice"),
          entityType: "Employee",
          attribute: ":employee/name",
          value: string("Alice"),
        },
        {
          op: "assert",
          entityId: eid("employee:alice"),
          entityType: "Employee",
          attribute: ":employee/age",
          value: string("unknown"),
        },
      ]);

      const before = yield* validation.currentInvalid("live");
      const first = yield* validation.revalidate({ ref: "live" });
      const current = yield* validation.currentInvalid("live");
      const age = (yield* triples.match({
        entityId: eid("employee:alice"),
        attribute: ":employee/age",
      }))[0]!;
      yield* triples.transact([
        { op: "retract", id: age.id },
        {
          op: "assert",
          entityId: eid("employee:alice"),
          entityType: "Employee",
          attribute: ":employee/age",
          value: number(30),
        },
      ]);
      const stale = yield* validation.currentInvalid("live");
      const second = yield* validation.revalidate({ ref: "live" });
      const repaired = yield* validation.currentInvalid("live");

      return {
        before: { status: before.status, invalid: before.invalid.map((row) => row.subject) },
        first: {
          sourcePosition: first.sourcePosition,
          valid: first.results.map((result) => result.valid),
        },
        current: { status: current.status, invalid: current.invalid.map((row) => row.subject) },
        stale: {
          status: stale.status,
          sourcePosition: stale.sourcePosition,
          currentPosition: stale.currentPosition,
          invalid: stale.invalid.map((row) => row.subject),
        },
        second: {
          sourcePosition: second.sourcePosition,
          valid: second.results.map((result) => result.valid),
        },
        repaired: {
          status: repaired.status,
          invalid: repaired.invalid.map((row) => row.subject),
        },
      };
    });

    const runValidation = (triplesLayer: Layer.Layer<Triples, unknown, never>) => {
      const configLayer = ConfigStore.layer.pipe(Layer.provideMerge(triplesLayer));
      const layer = EntityValidation.layer.pipe(Layer.provideMerge(configLayer));
      return Effect.runPromise(program.pipe(Effect.provide(layer)));
    };
    const [kv, sqlite] = await Promise.all([
      runValidation(KvTriples.layer),
      runValidation(SqliteTriples.layerMemory),
    ]);

    expect(sqlite).toEqual(kv);
    expect(kv).toEqual({
      before: { status: "unvalidated", invalid: [] },
      first: { sourcePosition: 2, valid: [false] },
      current: { status: "current", invalid: ["employee:alice"] },
      stale: {
        status: "stale",
        sourcePosition: 2,
        currentPosition: 4,
        invalid: ["employee:alice"],
      },
      second: { sourcePosition: 4, valid: [true] },
      repaired: { status: "current", invalid: [] },
    });
  });
});
