import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  EntityId,
  Triples,
  string,
  number,
  boolean,
  datetime,
  json,
  ref,
  type DatalogQuery,
  type WrappedQuery,
} from "@bjacobso/triplex";
import { QueryExecutor } from "@bjacobso/triplex/internal";
import { SqliteTriples } from "@bjacobso/triplex-sqlite";
import { DuckdbSnapshot, makeDuckdbSnapshot } from "../src/index.js";

const names: DatalogQuery = { find: ["?e", "?name"], where: [["?e", ":name", "?name"]] };
const normalize = (rows: readonly unknown[]) => rows.map((row) => JSON.stringify(row)).sort();
const run = <A, E>(program: Effect.Effect<A, E, Triples | QueryExecutor | SqlClient.SqlClient>) =>
  Effect.runPromise(program.pipe(Effect.provide(SqliteTriples.layerMemory)));

const seed = Effect.gen(function* () {
  const triples = yield* Triples;
  yield* triples.assertBatch([
    { entityId: EntityId.make("a"), attribute: ":name", value: string("Alice") },
    { entityId: EntityId.make("b"), attribute: ":name", value: string("Bob") },
    { entityId: EntityId.make("c"), attribute: ":name", value: string("Carol") },
    { entityId: EntityId.make("a"), attribute: ":score", value: number(7.25) },
    { entityId: EntityId.make("b"), attribute: ":score", value: number(12) },
    { entityId: EntityId.make("a"), attribute: ":active", value: boolean(true) },
    { entityId: EntityId.make("b"), attribute: ":active", value: boolean(false) },
    { entityId: EntityId.make("a"), attribute: ":date", value: datetime(1_700_000_000_123) },
    { entityId: EntityId.make("a"), attribute: ":json", value: json({ test: true }) },
    { entityId: EntityId.make("a"), attribute: ":parent", value: ref(EntityId.make("b")) },
    { entityId: EntityId.make("b"), attribute: ":parent", value: ref(EntityId.make("c")) },
    { entityId: EntityId.make("c"), attribute: ":parent", value: ref(EntityId.make("a")) },
    { entityId: EntityId.make("a"), attribute: ":mixed", value: string("7") },
    { entityId: EntityId.make("b"), attribute: ":mixed", value: number(7) },
    { entityId: EntityId.make("c"), attribute: ":mixed", value: boolean(true) },
  ]);
});

const recursive: DatalogQuery = {
  find: ["?descendant"],
  where: [["reach", "a", "?descendant"]],
  rules: [
    { name: "reach", body: [["?x", ":parent", "?y"]], maxDepth: 5 },
    {
      name: "reach",
      body: [
        ["?x", ":parent", "?z"],
        ["reach", "?z", "?y"],
      ],
      maxDepth: 5,
    },
  ],
};
const corpus: readonly DatalogQuery[] = [
  names,
  {
    find: ["?name", "?score"],
    where: [
      [">", "?score", 8],
      ["?e", ":name", "?name"],
      ["?e", ":score", "?score"],
    ],
  },
  {
    find: ["?name"],
    where: [
      ["?e", ":name", "?name"],
      ["not", ["?e", ":score", "?score"]],
    ],
  },
  {
    find: ["?e"],
    where: [
      ["?e", ":name", "?name"],
      [
        "or",
        [
          ["?e", ":name", "Alice"],
          ["?e", ":name", "Bob"],
        ],
      ],
    ],
  },
  { find: ["?v"], where: [["a", ":active", "?v"]] },
  { find: ["?v"], where: [["a", ":date", "?v"]] },
  { find: ["?v"], where: [["a", ":json", "?v"]] },
  { find: ["?v"], where: [["a", ":parent", "?v"]] },
  {
    find: ["?v"],
    where: [["?e", ":mixed", "?v"]],
    orderBy: [{ variable: "?v", direction: "asc" }],
  },
  {
    find: ["?active", "?count"],
    where: [["?e", ":active", "?active"]],
    aggregate: [["count", "?e", "?count"]],
  },
  { find: ["?sum"], where: [["?e", ":score", "?score"]], aggregate: [["sum", "?score", "?sum"]] },
  { find: ["?count"], where: [["?e", ":missing", "?v"]], aggregate: [["count", "?e", "?count"]] },
  { find: ["?name", 42, true], where: [["a", ":name", "?name"]] },
  recursive,
];

describe("DuckDB analytical snapshot", () => {
  it("matches SQLite for typed joins, negation, disjunction, aggregation, and cyclic recursion", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          yield* seed;
          const sqlite = yield* QueryExecutor;
          const snapshot = yield* makeDuckdbSnapshot({ scope: "test", batchSize: 3 });
          expect(snapshot.metadata.factCount).toBeGreaterThan(15);
          expect(snapshot.metadata.basis.recordedPosition).toBeGreaterThan(0);
          for (const query of corpus) {
            const expected = yield* sqlite.execute(query, false, snapshot.metadata.basis);
            const actual = yield* snapshot.queryAll(query, true);
            expect(normalize(actual.results), JSON.stringify(query)).toEqual(
              normalize(expected.results),
            );
            expect(actual.debug?.queryPlan?.backend).toBe("duckdb");
          }
        }),
      ),
    ));

  it("matches ordered windows, counts, boolean filters, and ILIKE", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          yield* seed;
          const sqlite = yield* QueryExecutor;
          const snapshot = yield* makeDuckdbSnapshot({ scope: "test" });
          const windows: WrappedQuery[] = [
            {
              inner: { ...names, offset: 1, orderBy: [{ variable: "?name", direction: "asc" }] },
              limit: 1,
              includeCount: true,
              orderBy: [{ variable: "?name", direction: "asc" }],
            },
            {
              inner: names,
              filters: [{ column: "?name", op: "ilike", value: "a%" }],
              includeCount: true,
            },
            { inner: names, filters: [{ column: "?name", op: "not-ilike", value: "a%" }] },
            {
              inner: { find: ["?active"], where: [["?e", ":active", "?active"]] },
              filters: [{ column: "?active", op: "=", value: true }],
            },
            {
              inner: recursive,
              limit: 2,
              includeCount: true,
              orderBy: [{ variable: "?descendant", direction: "asc" }],
            },
          ];
          for (const query of windows) {
            const expected = yield* sqlite.executePage(query, false, snapshot.metadata.basis);
            const actual = yield* snapshot.queryWindow(query, true);
            expect(actual.results).toEqual(expected.results);
            expect(actual.totalCount).toEqual(expected.totalCount);
          }
        }),
      ),
    ));

  it("keeps old facts after source retraction and excludes subsequent assertions", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const triples = yield* Triples;
          const alice = yield* triples.assert({
            entityId: EntityId.make("a"),
            attribute: ":name",
            value: string("Alice"),
          });
          const snapshot = yield* makeDuckdbSnapshot({ scope: "test", batchSize: 1 });
          yield* triples.retract(alice.id);
          yield* triples.assert({
            entityId: EntityId.make("b"),
            attribute: ":name",
            value: string("Bob"),
          });
          expect((yield* snapshot.queryAll(names)).results).toEqual([
            { "?e": "a", "?name": "Alice" },
          ]);
          const next = yield* makeDuckdbSnapshot({ scope: "test" });
          expect(next.metadata.basis.recordedPosition).toBeGreaterThan(
            snapshot.metadata.basis.recordedPosition!,
          );
          expect((yield* next.queryAll(names)).results).toEqual([{ "?e": "b", "?name": "Bob" }]);
        }),
      ),
    ));

  it("preserves recorded history and valid-time intervals", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(`INSERT INTO triples
        (id, entity_id, attribute, value_type, value_string, recorded_at, recorded_position,
         retracted_at, retracted_position, valid_from, valid_to)
        VALUES ('old','a',':name','string','Old',10,1,20,2,100,200),
               ('new','a',':name','string','New',20,2,NULL,NULL,100,NULL)`);
          yield* sql.unsafe("INSERT INTO triplex_commit_position VALUES (1,2)");
          for (const [basis, expected] of [
            [{ recordedAt: 15, validAt: 150 }, "Old"],
            [{ recordedAt: 25, validAt: 150 }, "New"],
            [{ recordedAt: 15, validAt: 200 }, undefined],
          ] as const) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const snapshot = yield* makeDuckdbSnapshot({ scope: "history", basis });
                const result = yield* snapshot.queryAll(names);
                expect(result.results).toEqual(
                  expected === undefined ? [] : [{ "?e": "a", "?name": expected }],
                );
              }),
            );
          }
        }),
      ),
    ));

  it(
    "holds one SQLite read snapshot when another connection commits between batches",
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const directory = yield* Effect.acquireRelease(
              Effect.tryPromise(() => mkdtemp(join(tmpdir(), "triplex-duckdb-"))),
              (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
            );
            const filename = join(directory, "source.sqlite");
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* seed;
                const source = yield* SqlClient.SqlClient;
                let wrote = false;
                const writer = Effect.gen(function* () {
                  const triples = yield* Triples;
                  yield* triples.retractByPattern({ attribute: ":name" });
                  yield* triples.assert({
                    entityId: EntityId.make("d"),
                    attribute: ":name",
                    value: string("Dora"),
                  });
                }).pipe(Effect.provide(SqliteTriples.layer({ filename })));
                const intercepted = new Proxy(source, {
                  get(target, property, receiver) {
                    if (property !== "unsafe") return Reflect.get(target, property, receiver);
                    return (statement: string, params: readonly unknown[] = []) =>
                      target.unsafe(statement, [...params]).pipe(
                        Effect.tap(() => {
                          if (wrote || !statement.startsWith('SELECT "id"')) return Effect.void;
                          wrote = true;
                          return writer;
                        }),
                      );
                  },
                });
                const snapshot = yield* makeDuckdbSnapshot({ scope: filename, batchSize: 1 }).pipe(
                  Effect.provideService(SqlClient.SqlClient, intercepted),
                );
                expect(wrote).toBe(true);
                expect(normalize((yield* snapshot.queryAll(names)).results)).toEqual(
                  normalize([
                    { "?e": "a", "?name": "Alice" },
                    { "?e": "b", "?name": "Bob" },
                    { "?e": "c", "?name": "Carol" },
                  ]),
                );
                const triples = yield* Triples;
                expect((yield* triples.queryAll(names)).results).toEqual([
                  { "?e": "d", "?name": "Dora" },
                ]);
              }),
            ).pipe(Effect.provide(SqliteTriples.layer({ filename })));
          }),
        ),
      ),
    15_000,
  );

  it("provides an empty snapshot through its Effect layer", () =>
    run(
      Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
          const snapshot = yield* DuckdbSnapshot;
          expect(snapshot.metadata.factCount).toBe(0);
          return yield* snapshot.queryAll(names);
        }).pipe(Effect.provide(DuckdbSnapshot.layer({ scope: "empty" })));
        expect(result.results).toEqual([]);
      }),
    ));

  it("returns typed failures for invalid configuration and queries", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const invalid = yield* Effect.result(makeDuckdbSnapshot({ scope: "test", batchSize: 0 }));
          expect(invalid._tag).toBe("Failure");
          const snapshot = yield* makeDuckdbSnapshot({ scope: "test" });
          const result = yield* Effect.result(snapshot.queryAll({ find: ["?unbound"], where: [] }));
          expect(result._tag).toBe("Failure");
        }),
      ),
    ));
});
