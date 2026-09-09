import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Result } from "effect";
import { TRIPLES_TABLE_DDL, COMMIT_POSITION_TABLE_DDL } from "@bjacobso/triplex-sql";
// Exercise the built worker entry and public API, including its package-relative fork path.
import {
  makeDuckdbFederation,
  SnapshotProvider,
  sourceEntity,
  decodeSourceEntity,
  databaseEntity,
  type FederatedQuery,
  type LocalDatabase,
} from "../dist/index.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const fixture = (): readonly LocalDatabase[] => {
  const directory = mkdtempSync(join(tmpdir(), "triplex-federation-"));
  directories.push(directory);
  return ["a", "b"].map((id) => {
    const filename = join(directory, `${id}.sqlite`);
    const db = new DatabaseSync(filename);
    db.exec(
      `${TRIPLES_TABLE_DDL}; ${COMMIT_POSITION_TABLE_DDL}; INSERT INTO triplex_commit_position VALUES (1, 7)`,
    );
    const insert =
      db.prepare(`INSERT INTO triples (id, entity_id, attribute, value_type, value_string, value_number,
      recorded_at, recorded_position, valid_from, tx_id) VALUES (?, ?, ?, ?, ?, ?, 10, 1, 0, 'tx:1')`);
    insert.run("1", "person:1", ":person/email", "string", "shared@example.com", null);
    insert.run("2", "person:1", ":person/name", "string", id === "a" ? "Alice" : "Bob", null);
    insert.run("3", "person:1", ":person/score", "number", null, id === "a" ? 7 : 11);
    insert.run("4", "person:1", ":person/friend", "ref", "person:2", null);
    insert.run("5", "person:2", ":person/name", "string", id === "a" ? "Ann" : "Ben", null);
    insert.run("6", "person:2", ":person/friend", "ref", "person:1", null);
    insert.run("7", "person:1", ":history", "string", "old", null);
    db.exec("UPDATE triples SET retracted_at = 20, retracted_position = 2 WHERE id = '7'");
    insert.run("8", "person:1", ":future", "string", "future", null);
    db.exec("UPDATE triples SET valid_from = 200 WHERE id = '8'");
    insert.run(
      "9",
      "person:1",
      ":typed",
      id === "a" ? "string" : "number",
      id === "a" ? "7" : null,
      id === "a" ? null : 7,
    );
    db.close();
    return { id, tenant: `tenant-${id}`, filename, basis: { validAt: 100 } };
  });
};
const joinQuery: FederatedQuery = {
  sources: { $a: "a", $b: "b" },
  find: ["?a", "?b", "?email"],
  where: [
    ["$a", "?a", ":person/email", "?email"],
    ["$b", "?b", ":person/email", "?email"],
  ],
};
const membershipQuery: FederatedQuery = {
  find: ["?a", "?b", "?email"],
  where: [
    ["?dbA", ":triplex/tenant", "tenant-a"],
    ["?a", ":triplex/database", "?dbA"],
    ["?dbB", ":triplex/tenant", "tenant-b"],
    ["?b", ":triplex/database", "?dbB"],
    ["?a", ":person/email", "?email"],
    ["?b", ":person/email", "?email"],
  ],
};
const normalize = (rows: readonly unknown[]) => rows.map((row) => JSON.stringify(row)).sort();
const run = <A, E>(
  catalog: readonly LocalDatabase[],
  effect: Effect.Effect<A, E, SnapshotProvider>,
) => Effect.runPromise(effect.pipe(Effect.provide(SnapshotProvider.local(catalog))));

describe("local DuckDB federation", () => {
  it("joins two worker snapshots with either syntax and matches the in-process reference", async () => {
    const catalog = fixture();
    let pids: readonly number[] = [];
    await run(
      catalog,
      Effect.scoped(
        Effect.gen(function* () {
          const distributed = yield* makeDuckdbFederation({ batchSize: 2 });
          const local = yield* makeDuckdbFederation({ mode: "in-process", batchSize: 3 });
          pids = distributed.sources.map((source) => source.pid);
          expect(new Set(pids).size).toBe(2);
          expect(pids).not.toContain(process.pid);
          const result = yield* distributed.queryAll(joinQuery, true);
          expect(result.results).toEqual([
            {
              "?a": sourceEntity("a", "person:1"),
              "?b": sourceEntity("b", "person:1"),
              "?email": "shared@example.com",
            },
          ]);
          expect(result.debug?.generatedSql).toContain("SELECT");
          expect((yield* distributed.queryAll(membershipQuery)).results).toEqual(result.results);
          const corpus: readonly FederatedQuery[] = [
            joinQuery,
            membershipQuery,
            {
              find: ["?sum"],
              where: [["?p", ":person/score", "?score"]],
              aggregate: [["sum", "?score", "?sum"]],
            },
            {
              sources: { $a: "a" },
              find: ["?p"],
              where: [
                ["$a", "?p", ":person/name", "?n"],
                ["not", ["$a", "?p", ":person/email", "?email"]],
              ],
            },
            {
              find: ["?p"],
              where: [
                ["?p", ":person/name", "?n"],
                [
                  "or",
                  [
                    ["?p", ":person/name", "Alice"],
                    ["?p", ":person/name", "Ben"],
                  ],
                ],
              ],
            },
            {
              find: ["?to"],
              where: [["reach", sourceEntity("a", "person:1"), "?to"]],
              rules: [
                { name: "reach", body: [["?x", ":person/friend", "?y"]], maxDepth: 3 },
                {
                  name: "reach",
                  body: [
                    ["?x", ":person/friend", "?z"],
                    ["reach", "?z", "?y"],
                  ],
                  maxDepth: 3,
                },
              ],
            },
          ];
          for (const query of corpus)
            expect(normalize((yield* distributed.queryAll(query)).results)).toEqual(
              normalize((yield* local.queryAll(query)).results),
            );
          const total = yield* distributed.queryAll(corpus[2]!);
          expect(total.results).toEqual([{ "?sum": 18 }]);
          const reach = yield* distributed.queryAll(corpus[5]!);
          expect(reach.results).toHaveLength(2);
          expect(
            reach.results.every((row) => decodeSourceEntity(String(row["?to"]))?.database === "a"),
          ).toBe(true);
          const window = yield* distributed.queryWindow({
            inner: membershipQuery,
            orderBy: [{ variable: "?email", direction: "asc" }],
            limit: 1,
            includeCount: true,
          });
          expect(window.results).toEqual(result.results);
        }),
      ),
    );
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);

  it(
    "qualifies entity/ref/transaction identities and preserves typed scalar joins",
    () =>
      run(
        fixture(),
        Effect.scoped(
          Effect.gen(function* () {
            const db = yield* makeDuckdbFederation({ batchSize: 1 });
            const collision = yield* db.queryAll({
              ...joinQuery,
              find: ["?p"],
              where: [
                ["$a", "?p", ":person/name", "?a"],
                ["$b", "?p", ":person/name", "?b"],
              ],
            });
            expect(collision.results).toEqual([]);
            const typed = yield* db.queryAll({
              ...joinQuery,
              where: [
                ["$a", "?a", ":typed", "?email"],
                ["$b", "?b", ":typed", "?email"],
              ],
            });
            expect(typed.results).toEqual([]);
            const refs = yield* db.queryAll({
              sources: { $a: "a" },
              find: ["?friend"],
              where: [["$a", "person:1", ":person/friend", "?friend"]],
            });
            expect(refs.results).toEqual([{ "?friend": sourceEntity("a", "person:2") }]);
            const tx = yield* db.queryAll({
              find: ["?tx", "?tenant"],
              where: [
                ["?p", ":person/email", "?email", "?tx"],
                ["?tx", ":_tx/database", "?db"],
                ["?db", ":triplex/tenant", "?tenant"],
              ],
            });
            expect(normalize(tx.results)).toEqual(
              normalize([
                { "?tx": sourceEntity("a", "tx:1"), "?tenant": "tenant-a" },
                { "?tx": sourceEntity("b", "tx:1"), "?tenant": "tenant-b" },
              ]),
            );
            expect(decodeSourceEntity(sourceEntity("a:b%", "p:/%"))).toEqual({
              database: "a:b%",
              entity: "p:/%",
            });
            expect(sourceEntity("a", "b:c")).not.toBe(sourceEntity("a:b", "c"));
          }),
        ),
      ),
    30_000,
  );

  it("pins per-source temporal cuts across later writes and filters transfer by source and attribute", () => {
    const catalog = fixture();
    return run(
      catalog,
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* makeDuckdbFederation();
          const query: FederatedQuery = {
            sources: { $a: "a" },
            find: ["?p", "?name"],
            where: [["$a", "?p", ":person/name", "?name"]],
          };
          const before = yield* db.queryAll(query);
          expect(before.federation.fragments.map((fragment) => fragment.database)).toEqual(["a"]);
          expect(before.federation.fragments[0]?.attributes).toEqual([
            ":person/name",
            ":triplex/database",
          ]);
          expect(before.federation.rowsTransferred).toBe(5); // 2 names, 2 people + 1 transaction memberships
          expect(db.sources.map((source) => source.snapshot.basis.recordedPosition)).toEqual([
            7, 7,
          ]);
          yield* Effect.sync(() => {
            const writer = new DatabaseSync(catalog[0]!.filename);
            writer.exec(
              "BEGIN; UPDATE triples SET value_string = 'Changed', recorded_position = 8 WHERE id = '2'; UPDATE triplex_commit_position SET position = 8; COMMIT",
            );
            writer.close();
          });
          expect(normalize((yield* db.queryAll(query)).results)).toEqual(normalize(before.results));
          expect(
            (yield* db.queryAll({ find: ["?p"], where: [["?p", ":future", "?v"]] })).results,
          ).toEqual([]);
          expect(
            (yield* db.queryAll({ find: ["?p"], where: [["?p", ":history", "?v"]] })).results,
          ).toEqual([]);
          const next = yield* makeDuckdbFederation({ mode: "in-process" });
          expect((yield* next.queryAll(query)).results).toContainEqual({
            "?p": sourceEntity("a", "person:1"),
            "?name": "Changed",
          });
          expect(next.sources[0]?.snapshot.basis.recordedPosition).toBe(8);
        }),
      ),
    );
  }, 30_000);

  it("supports distinct historical bases, metadata-only queries, and variable attributes", () => {
    const catalog = fixture().map((db) =>
      db.id === "a" ? { ...db, basis: { validAt: 100, recordedAt: 15 } } : db,
    );
    return run(
      catalog,
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* makeDuckdbFederation();
          expect(
            (yield* db.queryAll({ find: ["?p"], where: [["?p", ":history", "old"]] })).results,
          ).toEqual([{ "?p": sourceEntity("a", "person:1") }]);
          const members = yield* db.queryAll({
            find: ["?p"],
            where: [["?p", ":triplex/database", { type: "ref", value: databaseEntity("a") }]],
          });
          expect(members.results).toHaveLength(3);
          const wildcard = yield* db.queryAll({
            sources: { $a: "a" },
            find: ["?attr"],
            where: [["$a", "person:1", "?attr", "?value"]],
          });
          expect(wildcard.federation.fragments[0]?.attributes).toBeNull();
          expect(wildcard.results).toContainEqual({ "?attr": ":history" });
          expect(
            (yield* db.queryAll({ find: ["?db"], where: [["?db", ":triplex/tenant", "tenant-b"]] }))
              .results,
          ).toEqual([{ "?db": databaseEntity("b") }]);
        }),
      ),
    );
  }, 30_000);

  it(
    "keeps unscoped and optional facts and prunes an explicit tenant selector",
    () =>
      run(
        fixture(),
        Effect.scoped(
          Effect.gen(function* () {
            const db = yield* makeDuckdbFederation();
            const mixed = yield* db.queryAll({
              sources: { $a: "a" },
              find: ["?name"],
              where: [
                ["$a", "?p", ":person/email", "?email"],
                ["?other", ":person/email", "?email"],
                ["?other", ":person/name", "?name"],
              ],
            });
            expect(normalize(mixed.results)).toEqual(
              normalize([{ "?name": "Alice" }, { "?name": "Bob" }]),
            );
            expect(mixed.federation.fragments).toHaveLength(2);
            const optional = yield* db.queryAll({
              find: ["?name"],
              where: [["?p", ":person/email", "?email"]],
              optionalProjection: {
                rowBinding: "?p",
                fields: [{ attribute: ":person/name", variable: "?name" }],
              },
            });
            expect(normalize(optional.results)).toEqual(normalize(mixed.results));
            const selected = yield* db.queryAll({
              find: ["?name"],
              where: [
                ["?db", ":triplex/tenant", "tenant-a"],
                ["?p", ":triplex/database", "?db"],
                ["?p", ":person/name", "?name"],
              ],
            });
            expect(selected.federation.fragments.map((fragment) => fragment.database)).toEqual([
              "a",
            ]);
            expect(normalize(selected.results)).toEqual(
              normalize([{ "?name": "Alice" }, { "?name": "Ann" }]),
            );
          }),
        ),
      ),
    30_000,
  );

  it("rejects unknown aliases, reserved data, and unreadable sources; reports worker exits", async () => {
    const catalog = fixture();
    await run(
      catalog,
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* makeDuckdbFederation();
          expect(
            Result.isFailure(
              yield* Effect.result(
                db.queryAll({ ...joinQuery, sources: { $a: "missing", $b: "b" } }),
              ),
            ),
          ).toBe(true);
          yield* Effect.sync(() => process.kill(db.sources[0]!.pid, "SIGKILL"));
          const result = yield* Effect.result(db.queryAll(joinQuery));
          expect(Result.isFailure(result)).toBe(true);
        }),
      ),
    );
    await expect(
      run(
        [{ ...catalog[0]!, filename: join(directories[0]!, "missing.sqlite") }],
        Effect.scoped(makeDuckdbFederation()),
      ),
    ).rejects.toThrow();
    await expect(
      run(catalog, Effect.scoped(makeDuckdbFederation({ workerTimeoutMs: 1 }))),
    ).rejects.toThrow(/timed out/);
    const writer = new DatabaseSync(catalog[0]!.filename);
    writer.exec("UPDATE triples SET attribute = ':triplex/database' WHERE id = '1'");
    writer.close();
    await expect(
      run(catalog, Effect.scoped(makeDuckdbFederation({ mode: "in-process" }))),
    ).rejects.toThrow(/reserved/);
  }, 30_000);
});
