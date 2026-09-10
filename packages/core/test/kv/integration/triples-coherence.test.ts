/**
 * Integration tests for write/query coherence through Triples.
 *
 * These tests verify that data written through Triples is queryable through
 * the same service, exercising the
 * full stack: InMemoryKvBackend → Hexastore → Layer adapters → Effect services.
 */

import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { Triples } from "../../../src/store/Triples.js";
import type { EntityId } from "@triplex-build/triplex";
import { KvTriplesLive } from "../../../src/kv/layers/KvTriplesLive.js";
import { KvBackend } from "../../../src/kv/kv/KvBackend.js";
import { makeTestKvBackend } from "../../../src/kv/kv/InMemoryKvBackend.js";
import { TripleStoreRuntimeLayer } from "../../../src/store/TripleStoreRuntime.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

const str = (value: string) => ({ type: "string" as const, value });
const num = (value: number) => ({ type: "number" as const, value });
const bool = (value: boolean) => ({ type: "boolean" as const, value });
const refVal = (value: string) => ({ type: "ref" as const, value });

const makeTestLayer = () => {
  const freshKvBackend = Layer.effect(
    KvBackend,
    Effect.sync(() => makeTestKvBackend()),
  );
  return KvTriplesLive.pipe(Layer.provide(TripleStoreRuntimeLayer), Layer.provide(freshKvBackend));
};

const runTest = <A, E>(effect: Effect.Effect<A, E, Triples>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, makeTestLayer()));

// ─── Seed data ─────────────────────────────────────────────────────────────

const seedCompanyData = Effect.gen(function* () {
  const store = yield* Triples;

  // Departments
  yield* store.assertBatch([
    { entityId: "dept:eng", attribute: ":dept/name", value: str("Engineering") },
    { entityId: "dept:eng", attribute: ":dept/budget", value: num(500000) },
    { entityId: "dept:sales", attribute: ":dept/name", value: str("Sales") },
    { entityId: "dept:sales", attribute: ":dept/budget", value: num(300000) },
    { entityId: "dept:hr", attribute: ":dept/name", value: str("Human Resources") },
    { entityId: "dept:hr", attribute: ":dept/budget", value: num(200000) },
  ]);

  // Employees
  yield* store.assertBatch([
    { entityId: "emp:alice", attribute: ":emp/name", value: str("Alice") },
    { entityId: "emp:alice", attribute: ":emp/age", value: num(32) },
    { entityId: "emp:alice", attribute: ":emp/dept", value: refVal("dept:eng") },
    { entityId: "emp:alice", attribute: ":emp/active", value: bool(true) },
    { entityId: "emp:alice", attribute: ":emp/salary", value: num(120000) },

    { entityId: "emp:bob", attribute: ":emp/name", value: str("Bob") },
    { entityId: "emp:bob", attribute: ":emp/age", value: num(28) },
    { entityId: "emp:bob", attribute: ":emp/dept", value: refVal("dept:eng") },
    { entityId: "emp:bob", attribute: ":emp/active", value: bool(true) },
    { entityId: "emp:bob", attribute: ":emp/salary", value: num(95000) },

    { entityId: "emp:charlie", attribute: ":emp/name", value: str("Charlie") },
    { entityId: "emp:charlie", attribute: ":emp/age", value: num(45) },
    { entityId: "emp:charlie", attribute: ":emp/dept", value: refVal("dept:sales") },
    { entityId: "emp:charlie", attribute: ":emp/active", value: bool(true) },
    { entityId: "emp:charlie", attribute: ":emp/salary", value: num(110000) },

    { entityId: "emp:diana", attribute: ":emp/name", value: str("Diana") },
    { entityId: "emp:diana", attribute: ":emp/age", value: num(38) },
    { entityId: "emp:diana", attribute: ":emp/dept", value: refVal("dept:hr") },
    { entityId: "emp:diana", attribute: ":emp/active", value: bool(false) },
    { entityId: "emp:diana", attribute: ":emp/salary", value: num(85000) },
  ]);

  // Projects
  yield* store.assertBatch([
    { entityId: "proj:alpha", attribute: ":proj/name", value: str("Alpha") },
    { entityId: "proj:alpha", attribute: ":proj/lead", value: refVal("emp:alice") },
    { entityId: "proj:beta", attribute: ":proj/name", value: str("Beta") },
    { entityId: "proj:beta", attribute: ":proj/lead", value: refVal("emp:charlie") },
  ]);
});

// ─── Basic integration ────────────────────────────────────────────────────

describe("Integration: Triples → Datalog", () => {
  it("queries data written through the same Triples service", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedCompanyData;
        const datalog = yield* Triples;

        const { results } = yield* datalog.query({
          find: ["?name"],
          where: [["?e", ":emp/name", "?name"]],
        });

        const names = results.map((r) => r["?name"]).sort();
        expect(names).toEqual(["Alice", "Bob", "Charlie", "Diana"]);
      }),
    );
  });

  it("joins across entities written via assertBatch", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedCompanyData;
        const datalog = yield* Triples;

        const { results } = yield* datalog.query({
          find: ["?empName", "?deptName"],
          where: [
            ["?e", ":emp/name", "?empName"],
            ["?e", ":emp/dept", "?dept"],
            ["?dept", ":dept/name", "?deptName"],
          ],
          orderBy: [{ variable: "?empName" }],
        });

        expect(results.length).toBe(4);
        expect(results[0]).toEqual({ "?empName": "Alice", "?deptName": "Engineering" });
        expect(results[1]).toEqual({ "?empName": "Bob", "?deptName": "Engineering" });
        expect(results[2]).toEqual({ "?empName": "Charlie", "?deptName": "Sales" });
        expect(results[3]).toEqual({ "?empName": "Diana", "?deptName": "Human Resources" });
      }),
    );
  });

  it("filters with predicates on data written via Triples", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedCompanyData;
        const datalog = yield* Triples;

        const { results } = yield* datalog.query({
          find: ["?name", "?age"],
          where: [
            ["?e", ":emp/name", "?name"],
            ["?e", ":emp/age", "?age"],
            [">=", "?age", 35],
          ],
          orderBy: [{ variable: "?name" }],
        });

        expect(results.length).toBe(2);
        expect(results[0]).toEqual({ "?name": "Charlie", "?age": 45 });
        expect(results[1]).toEqual({ "?name": "Diana", "?age": 38 });
      }),
    );
  });
});

// ─── Retraction visibility ────────────────────────────────────────────────

describe("Integration: retraction visibility in Datalog", () => {
  it("retracted triples are not visible to Datalog queries", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedCompanyData;
        const store = yield* Triples;
        const datalog = yield* Triples;

        // Find Diana's name triple and retract it
        const dianaTriples = yield* store.match({ entityId: "emp:diana", attribute: ":emp/name" });
        expect(dianaTriples.length).toBe(1);
        yield* store.retract(dianaTriples[0]!.id);

        // Datalog query should no longer find Diana
        const { results } = yield* datalog.query({
          find: ["?name"],
          where: [["?e", ":emp/name", "?name"]],
        });

        const names = results.map((r) => r["?name"]).sort();
        expect(names).toEqual(["Alice", "Bob", "Charlie"]);
      }),
    );
  });

  it("retract-by-pattern removes all matching triples from Datalog view", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedCompanyData;
        const store = yield* Triples;
        const datalog = yield* Triples;

        // Retract all of Bob's triples
        const count = yield* store.retractByPattern({ entityId: "emp:bob" });
        expect(count).toBe(5); // name, age, dept, active, salary

        // Bob should not appear in join query
        const { results } = yield* datalog.query({
          find: ["?name", "?deptName"],
          where: [
            ["?e", ":emp/name", "?name"],
            ["?e", ":emp/dept", "?dept"],
            ["?dept", ":dept/name", "?deptName"],
          ],
          orderBy: [{ variable: "?name" }],
        });

        expect(results.length).toBe(3);
        expect(results.map((r) => r["?name"])).toEqual(["Alice", "Charlie", "Diana"]);
      }),
    );
  });
});

// ─── Transact + query ─────────────────────────────────────────────────────

describe("Integration: transact + Datalog query", () => {
  it("data added via transact is queryable", async () => {
    await runTest(
      Effect.gen(function* () {
        const store = yield* Triples;
        const datalog = yield* Triples;

        yield* store.transact([
          { op: "assert", entityId: "item:1", attribute: ":item/name", value: str("Widget") },
          { op: "assert", entityId: "item:1", attribute: ":item/price", value: num(9.99) },
          { op: "assert", entityId: "item:2", attribute: ":item/name", value: str("Gadget") },
          { op: "assert", entityId: "item:2", attribute: ":item/price", value: num(19.99) },
        ]);

        const { results } = yield* datalog.query({
          find: ["?name", "?price"],
          where: [
            ["?item", ":item/name", "?name"],
            ["?item", ":item/price", "?price"],
            [">", "?price", 10],
          ],
        });

        expect(results.length).toBe(1);
        expect(results[0]).toEqual({ "?name": "Gadget", "?price": 19.99 });
      }),
    );
  });

  it("retract in transact removes data from Datalog view", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedCompanyData;
        const store = yield* Triples;
        const datalog = yield* Triples;

        // Get Alice's salary triple
        const salaryTriples = yield* store.match({
          entityId: "emp:alice",
          attribute: ":emp/salary",
        });

        // Transact: retract old salary + assert new salary
        yield* store.transact([
          { op: "retract", id: salaryTriples[0]!.id },
          { op: "assert", entityId: "emp:alice", attribute: ":emp/salary", value: num(140000) },
        ]);

        // Query should see the new salary
        const { results } = yield* datalog.query({
          find: ["?name", "?salary"],
          where: [
            ["?e", ":emp/name", "?name"],
            ["?e", ":emp/salary", "?salary"],
          ],
          orderBy: [{ variable: "?name" }],
        });

        const alice = results.find((r) => r["?name"] === "Alice");
        expect(alice!["?salary"]).toBe(140000);
      }),
    );
  });
});

// ─── Multi-hop ref traversal ──────────────────────────────────────────────

describe("Integration: multi-hop ref traversal", () => {
  it("traverses project → lead → department in a single query", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedCompanyData;
        const datalog = yield* Triples;

        const { results } = yield* datalog.query({
          find: ["?projName", "?leadName", "?deptName"],
          where: [
            ["?proj", ":proj/name", "?projName"],
            ["?proj", ":proj/lead", "?lead"],
            ["?lead", ":emp/name", "?leadName"],
            ["?lead", ":emp/dept", "?dept"],
            ["?dept", ":dept/name", "?deptName"],
          ],
          orderBy: [{ variable: "?projName" }],
        });

        expect(results.length).toBe(2);
        expect(results[0]).toEqual({
          "?projName": "Alpha",
          "?leadName": "Alice",
          "?deptName": "Engineering",
        });
        expect(results[1]).toEqual({
          "?projName": "Beta",
          "?leadName": "Charlie",
          "?deptName": "Sales",
        });
      }),
    );
  });
});

// ─── Aggregation ──────────────────────────────────────────────────────────

describe("Integration: aggregation", () => {
  it("computes aggregate values over Triples data", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedCompanyData;
        const datalog = yield* Triples;

        // Count employees per department
        const { results } = yield* datalog.query({
          find: ["?deptName", "?count"],
          where: [
            ["?e", ":emp/name", "?name"],
            ["?e", ":emp/dept", "?dept"],
            ["?dept", ":dept/name", "?deptName"],
          ],
          aggregate: [["count", "?name", "?count"]],
          orderBy: [{ variable: "?deptName" }],
        });

        expect(results.length).toBe(3);
        expect(results[0]).toEqual({ "?deptName": "Engineering", "?count": 2 });
        expect(results[1]).toEqual({ "?deptName": "Human Resources", "?count": 1 });
        expect(results[2]).toEqual({ "?deptName": "Sales", "?count": 1 });
      }),
    );
  });

  it("sum of salaries per department", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedCompanyData;
        const datalog = yield* Triples;

        const { results } = yield* datalog.query({
          find: ["?deptName", "?totalSalary"],
          where: [
            ["?e", ":emp/salary", "?salary"],
            ["?e", ":emp/dept", "?dept"],
            ["?dept", ":dept/name", "?deptName"],
          ],
          aggregate: [["sum", "?salary", "?totalSalary"]],
          orderBy: [{ variable: "?deptName" }],
        });

        expect(results.length).toBe(3);
        expect(results[0]).toEqual({ "?deptName": "Engineering", "?totalSalary": 215000 });
        expect(results[1]).toEqual({ "?deptName": "Human Resources", "?totalSalary": 85000 });
        expect(results[2]).toEqual({ "?deptName": "Sales", "?totalSalary": 110000 });
      }),
    );
  });
});

// ─── Wrapped queries (pagination) ─────────────────────────────────────────

describe("Integration: wrapped queries", () => {
  it("paginates query results", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedCompanyData;
        const datalog = yield* Triples;

        // Page 1
        const page1 = yield* datalog.queryPage({
          inner: {
            find: ["?name", "?age"],
            where: [
              ["?e", ":emp/name", "?name"],
              ["?e", ":emp/age", "?age"],
            ],
          },
          orderBy: [{ variable: "?name", direction: "asc" }],
          limit: 2,
          includeCount: true,
        });

        expect(page1.results.length).toBe(2);
        expect(page1.totalCount).toBe(4);
        expect(page1.results[0]!["?name"]).toBe("Alice");
        expect(page1.results[1]!["?name"]).toBe("Bob");
      }),
    );
  });

  it("applies wrapper filters to Datalog results", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedCompanyData;
        const datalog = yield* Triples;

        const result = yield* datalog.queryPage({
          inner: {
            find: ["?name", "?salary"],
            where: [
              ["?e", ":emp/name", "?name"],
              ["?e", ":emp/salary", "?salary"],
            ],
          },
          filters: [{ column: "?salary", op: ">=", value: 100000 }],
          orderBy: [{ variable: "?name", direction: "asc" }],
        });

        expect(result.results.length).toBe(2);
        expect(result.results.map((r) => r["?name"])).toEqual(["Alice", "Charlie"]);
      }),
    );
  });
});

// ─── Negation ─────────────────────────────────────────────────────────────

describe("Integration: negation", () => {
  it("finds employees NOT in a specific department", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedCompanyData;
        const datalog = yield* Triples;

        // Use a variable for the department, then bind it via a join and
        // negate on department name. Direct constant refs in value position
        // don't work because the KV store stores typed values (ref vs string).
        const { results } = yield* datalog.query({
          find: ["?name"],
          where: [
            ["?e", ":emp/name", "?name"],
            ["?e", ":emp/dept", "?dept"],
            ["?dept", ":dept/name", "?deptName"],
            ["!=", "?deptName", "Engineering"],
          ],
          orderBy: [{ variable: "?name" }],
        });

        expect(results.length).toBe(2);
        expect(results.map((r) => r["?name"])).toEqual(["Charlie", "Diana"]);
      }),
    );
  });
});

// ─── History / time-travel with Datalog ───────────────────────────────────

describe("Integration: write → retract → Datalog sees current state", () => {
  it("after update, Datalog sees only the latest value", async () => {
    await runTest(
      Effect.gen(function* () {
        const store = yield* Triples;
        const datalog = yield* Triples;

        // Write initial value
        const t1 = yield* store.assert({
          entityId: "config:1",
          attribute: ":config/version",
          value: num(1),
        });

        // Update: retract old, assert new
        yield* store.retract(t1.id);
        yield* store.assert({
          entityId: "config:1",
          attribute: ":config/version",
          value: num(2),
        });

        // Datalog should see only version 2
        const { results } = yield* datalog.query({
          find: ["?version"],
          where: [["?e", ":config/version", "?version"]],
        });

        expect(results.length).toBe(1);
        expect(results[0]!["?version"]).toBe(2);
      }),
    );
  });
});

// ─── getEntity + Datalog consistency ──────────────────────────────────────

describe("Integration: Triples.getEntity and Datalog consistency", () => {
  it("getEntity and Datalog query return consistent data", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* seedCompanyData;
        const store = yield* Triples;
        const datalog = yield* Triples;

        // Get Alice's data via Triples
        const entityTriples = yield* store.entity("emp:alice" as EntityId);
        const tsName = entityTriples.find((t) => t.attribute === ":emp/name");
        const tsAge = entityTriples.find((t) => t.attribute === ":emp/age");

        // Get Alice's data via Datalog
        const { results } = yield* datalog.query({
          find: ["?name", "?age"],
          where: [
            ["emp:alice", ":emp/name", "?name"],
            ["emp:alice", ":emp/age", "?age"],
          ],
        });

        // Should be consistent
        expect(results.length).toBe(1);
        expect(tsName?.value).toEqual(str(results[0]!["?name"] as string));
        expect(tsAge?.value).toEqual(num(results[0]!["?age"] as number));
      }),
    );
  });
});
