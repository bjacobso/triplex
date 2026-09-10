import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  KvTripleStore,
  createKvTripleStore,
  type Datom,
} from "../../../src/kv/hexastore/KvTripleStore.js";
import { makeTestKvBackend } from "../../../src/kv/kv/InMemoryKvBackend.js";
import type { KvBackendService } from "../../../src/kv/kv/KvBackend.js";
import { executeQuery, executeWrappedQuery } from "../../../src/kv/datalog/executor.js";
import type { TripleValue } from "@triplex-build/triplex";
import type { DatalogQuery, WrappedQuery } from "../../../src/kv/datalog/types.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

const str = (value: string): TripleValue => ({ type: "string", value });
const num = (value: number): TripleValue => ({ type: "number", value });
const bool = (value: boolean): TripleValue => ({ type: "boolean", value });
const ref = (value: string): TripleValue => ({ type: "ref", value });

let counter = 0;
const makeDatom = (overrides: Partial<Datom> = {}): Datom => ({
  tripleId: `triple-${++counter}`,
  entity: "e:1",
  attribute: ":a",
  value: str("v"),
  txId: "tx:1",
  recordedAt: 1000,
  recordedPosition: 1,
  validFrom: 1000,
  validTo: null,
  createdBy: null,
  retractedAt: null,
  retractedPosition: null,
  retractTxId: null,
  entityType: null,
  ...overrides,
});

const run = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect);

let kv: KvBackendService;
let store: KvTripleStore;

beforeEach(() => {
  counter = 0;
  kv = makeTestKvBackend();
  store = createKvTripleStore(kv);
});

// ─── Seed data ─────────────────────────────────────────────────────────────

const seedPeople = async () => {
  const datoms = [
    makeDatom({ entity: "p:alice", attribute: ":person/name", value: str("Alice") }),
    makeDatom({ entity: "p:alice", attribute: ":person/age", value: num(30) }),
    makeDatom({ entity: "p:alice", attribute: ":person/active", value: bool(true) }),
    makeDatom({ entity: "p:bob", attribute: ":person/name", value: str("Bob") }),
    makeDatom({ entity: "p:bob", attribute: ":person/age", value: num(25) }),
    makeDatom({ entity: "p:bob", attribute: ":person/active", value: bool(true) }),
    makeDatom({ entity: "p:charlie", attribute: ":person/name", value: str("Charlie") }),
    makeDatom({ entity: "p:charlie", attribute: ":person/age", value: num(35) }),
    makeDatom({ entity: "p:charlie", attribute: ":person/active", value: bool(false) }),
  ];
  await run(store.assertBatch(datoms));
};

const seedDepartments = async () => {
  const datoms = [
    makeDatom({ entity: "d:eng", attribute: ":dept/name", value: str("Engineering") }),
    makeDatom({ entity: "d:sales", attribute: ":dept/name", value: str("Sales") }),
    makeDatom({ entity: "p:alice", attribute: ":person/dept", value: ref("d:eng") }),
    makeDatom({ entity: "p:bob", attribute: ":person/dept", value: ref("d:eng") }),
    makeDatom({ entity: "p:charlie", attribute: ":person/dept", value: ref("d:sales") }),
  ];
  await run(store.assertBatch(datoms));
};

// ─── Pattern clauses ───────────────────────────────────────────────────────

describe("pattern clauses", () => {
  beforeEach(seedPeople);

  it("finds all triples matching a single pattern", async () => {
    const query: DatalogQuery = {
      find: ["?name"],
      where: [["?person", ":person/name", "?name"]],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(3);
    const names = results.map((r) => r["?name"]).sort();
    expect(names).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("joins on shared variables", async () => {
    const query: DatalogQuery = {
      find: ["?name", "?age"],
      where: [
        ["?person", ":person/name", "?name"],
        ["?person", ":person/age", "?age"],
      ],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(3);

    const alice = results.find((r) => r["?name"] === "Alice");
    expect(alice).toBeDefined();
    expect(alice!["?age"]).toBe(30);
  });

  it("handles constant entity in pattern", async () => {
    const query: DatalogQuery = {
      find: ["?name"],
      where: [["p:alice", ":person/name", "?name"]],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(1);
    expect(results[0]!["?name"]).toBe("Alice");
  });

  it("handles constant value in pattern", async () => {
    const query: DatalogQuery = {
      find: ["?person"],
      where: [["?person", ":person/name", "Alice"]],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(1);
    expect(results[0]!["?person"]).toBe("p:alice");
  });

  it("produces empty results for non-matching pattern", async () => {
    const query: DatalogQuery = {
      find: ["?person"],
      where: [["?person", ":nonexistent/attr", "?val"]],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(0);
  });

  it("deduplicates results", async () => {
    // Two patterns that both bind ?person but we only ask for ?person
    const query: DatalogQuery = {
      find: ["?person"],
      where: [
        ["?person", ":person/name", "?name"],
        ["?person", ":person/age", "?age"],
      ],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(3); // Not 9 (3x3) because shared variable joins
  });
});

// ─── Predicate clauses ─────────────────────────────────────────────────────

describe("predicate clauses", () => {
  beforeEach(seedPeople);

  it("filters with >= predicate", async () => {
    const query: DatalogQuery = {
      find: ["?name", "?age"],
      where: [
        ["?person", ":person/name", "?name"],
        ["?person", ":person/age", "?age"],
        [">=", "?age", 30],
      ],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(2);
    const names = results.map((r) => r["?name"]).sort();
    expect(names).toEqual(["Alice", "Charlie"]);
  });

  it("filters with = predicate", async () => {
    const query: DatalogQuery = {
      find: ["?person"],
      where: [
        ["?person", ":person/age", "?age"],
        ["=", "?age", 25],
      ],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(1);
    expect(results[0]!["?person"]).toBe("p:bob");
  });

  it("filters with != predicate", async () => {
    const query: DatalogQuery = {
      find: ["?name"],
      where: [
        ["?person", ":person/name", "?name"],
        ["?person", ":person/age", "?age"],
        ["!=", "?age", 25],
      ],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(2);
    const names = results.map((r) => r["?name"]).sort();
    expect(names).toEqual(["Alice", "Charlie"]);
  });

  it("chains multiple predicates", async () => {
    const query: DatalogQuery = {
      find: ["?name"],
      where: [
        ["?person", ":person/name", "?name"],
        ["?person", ":person/age", "?age"],
        [">=", "?age", 25],
        ["<", "?age", 35],
      ],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(2);
    const names = results.map((r) => r["?name"]).sort();
    expect(names).toEqual(["Alice", "Bob"]);
  });
});

// ─── NOT clauses ───────────────────────────────────────────────────────────

describe("NOT clauses", () => {
  beforeEach(seedPeople);

  it("filters with negation", async () => {
    // People who don't have age 25
    const query: DatalogQuery = {
      find: ["?name"],
      where: [
        ["?person", ":person/name", "?name"],
        ["not", ["?person", ":person/age", 25]],
      ],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(2);
    const names = results.map((r) => r["?name"]).sort();
    expect(names).toEqual(["Alice", "Charlie"]);
  });

  it("negation with constant attribute value", async () => {
    // People whose name is not "Alice"
    const query: DatalogQuery = {
      find: ["?person"],
      where: [
        ["?person", ":person/name", "?name"],
        ["not", ["?person", ":person/name", "Alice"]],
      ],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(2);
    const people = results.map((r) => r["?person"]).sort();
    expect(people).toEqual(["p:bob", "p:charlie"]);
  });
});

// ─── OR clauses ────────────────────────────────────────────────────────────

describe("OR clauses", () => {
  beforeEach(seedPeople);

  it("filters with alternative patterns without leaking local bindings", async () => {
    // People named Alice OR age 25
    const query: DatalogQuery = {
      find: ["?person"],
      where: [
        ["?person", ":person/name", "?name"],
        [
          "or",
          [
            ["?person", ":person/name", "Alice"],
            ["?person", ":person/age", 25],
          ],
        ],
      ],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(2);
    const people = results.map((r) => r["?person"]).sort();
    expect(people).toEqual(["p:alice", "p:bob"]);
  });

  it("filters with predicate alternatives", async () => {
    const query: DatalogQuery = {
      find: ["?person"],
      where: [
        ["?person", ":person/age", "?age"],
        ["?person", ":person/active", "?active"],
        [
          "or",
          [
            ["=", "?age", 25],
            ["=", "?active", false],
          ],
        ],
      ],
    };

    const { results } = await run(executeQuery(store, query));
    const people = results.map((r) => r["?person"]).sort();
    expect(people).toEqual(["p:bob", "p:charlie"]);
  });

  it("filters with not alternatives", async () => {
    await run(
      store.assertBatch([
        makeDatom({ entity: "step:one", attribute: ":_schema/type", value: str("WorkflowStep") }),
        makeDatom({
          entity: "step:one",
          attribute: ":workflow-step/input-schema",
          value: str("Input"),
        }),
        makeDatom({ entity: "step:two", attribute: ":_schema/type", value: str("WorkflowStep") }),
        makeDatom({
          entity: "step:two",
          attribute: ":workflow-step/output-schema",
          value: str("Output"),
        }),
        makeDatom({
          entity: "step:three",
          attribute: ":_schema/type",
          value: str("WorkflowStep"),
        }),
        makeDatom({
          entity: "step:three",
          attribute: ":workflow-step/input-schema",
          value: str("Input"),
        }),
        makeDatom({
          entity: "step:three",
          attribute: ":workflow-step/output-schema",
          value: str("Output"),
        }),
      ]),
    );

    const query: DatalogQuery = {
      find: ["?step"],
      where: [
        ["?step", ":_schema/type", "WorkflowStep"],
        [
          "or",
          [
            ["not", ["?step", ":workflow-step/input-schema", "?is"]],
            ["not", ["?step", ":workflow-step/output-schema", "?os"]],
          ],
        ],
      ],
    };

    const { results } = await run(executeQuery(store, query));
    const steps = results.map((r) => r["?step"]).sort();
    expect(steps).toEqual(["step:one", "step:two"]);
  });
});

// ─── Ref values / joins ────────────────────────────────────────────────────

describe("ref value joins", () => {
  beforeEach(async () => {
    await seedPeople();
    await seedDepartments();
  });

  it("joins entities through ref values", async () => {
    const query: DatalogQuery = {
      find: ["?name", "?deptName"],
      where: [
        ["?person", ":person/name", "?name"],
        ["?person", ":person/dept", "?dept"],
        ["?dept", ":dept/name", "?deptName"],
      ],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(3);

    const alice = results.find((r) => r["?name"] === "Alice");
    expect(alice!["?deptName"]).toBe("Engineering");

    const charlie = results.find((r) => r["?name"] === "Charlie");
    expect(charlie!["?deptName"]).toBe("Sales");
  });
});

// ─── Aggregation ───────────────────────────────────────────────────────────

describe("aggregation", () => {
  beforeEach(seedPeople);

  it("counts results", async () => {
    const query: DatalogQuery = {
      find: ["?count"],
      where: [["?person", ":person/name", "?name"]],
      aggregate: [["count", "?person", "?count"]],
    };

    const { results } = await run(executeQuery(store, query));
    // count aggregation with no group-by returns a single row
    // since ?person is the aggregation input and only ?count is projected,
    // there is no grouping key and we get one group
    expect(results.length).toBe(1);
    expect(results[0]!["?count"]).toBe(3);
  });

  it("sums values", async () => {
    const query: DatalogQuery = {
      find: ["?totalAge"],
      where: [["?person", ":person/age", "?age"]],
      aggregate: [["sum", "?age", "?totalAge"]],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(1);
    expect(results[0]!["?totalAge"]).toBe(90); // 30 + 25 + 35
  });

  it("preserves duplicate aggregate inputs while count remains distinct", async () => {
    await run(
      store.assertBatch([
        makeDatom({ entity: "p:dana", attribute: ":person/age", value: num(30) }),
      ]),
    );

    const { results } = await run(
      executeQuery(store, {
        find: ["?totalAge", "?distinctAges"],
        where: [["?person", ":person/age", "?age"]],
        aggregate: [
          ["sum", "?age", "?totalAge"],
          ["count", "?age", "?distinctAges"],
        ],
      }),
    );

    expect(results).toEqual([{ "?totalAge": 120, "?distinctAges": 3 }]);
  });

  it("returns SQL-compatible values for an empty ungrouped aggregate", async () => {
    const { results } = await run(
      executeQuery(store, {
        find: ["?count", "?sum", "?average", "?minimum", "?maximum"],
        where: [["?person", ":person/missing", "?value"]],
        aggregate: [
          ["count", "?value", "?count"],
          ["sum", "?value", "?sum"],
          ["avg", "?value", "?average"],
          ["min", "?value", "?minimum"],
          ["max", "?value", "?maximum"],
        ],
      }),
    );

    expect(results).toEqual([
      {
        "?count": 0,
        "?sum": null,
        "?average": null,
        "?minimum": null,
        "?maximum": null,
      },
    ]);
  });

  it("computes average", async () => {
    const query: DatalogQuery = {
      find: ["?avgAge"],
      where: [["?person", ":person/age", "?age"]],
      aggregate: [["avg", "?age", "?avgAge"]],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(1);
    expect(results[0]!["?avgAge"]).toBe(30); // (30 + 25 + 35) / 3
  });

  it("finds min and max", async () => {
    const queryMin: DatalogQuery = {
      find: ["?minAge"],
      where: [["?person", ":person/age", "?age"]],
      aggregate: [["min", "?age", "?minAge"]],
    };

    const { results: minResults } = await run(executeQuery(store, queryMin));
    expect(minResults[0]!["?minAge"]).toBe(25);

    const queryMax: DatalogQuery = {
      find: ["?maxAge"],
      where: [["?person", ":person/age", "?age"]],
      aggregate: [["max", "?age", "?maxAge"]],
    };

    const { results: maxResults } = await run(executeQuery(store, queryMax));
    expect(maxResults[0]!["?maxAge"]).toBe(35);
  });

  it("groups by non-aggregated variable", async () => {
    // First add department data
    await seedDepartments();

    const query: DatalogQuery = {
      find: ["?dept", "?count"],
      where: [["?person", ":person/dept", "?dept"]],
      aggregate: [["count", "?person", "?count"]],
    };

    const { results } = await run(executeQuery(store, query));
    // Grouped by ?dept (the non-aggregated find var)
    expect(results.length).toBe(2); // d:eng and d:sales

    const eng = results.find((r) => r["?dept"] === "d:eng");
    expect(eng!["?count"]).toBe(2); // Alice and Bob

    const sales = results.find((r) => r["?dept"] === "d:sales");
    expect(sales!["?count"]).toBe(1); // Charlie
  });
});

// ─── HAVING ────────────────────────────────────────────────────────────────

describe("HAVING", () => {
  beforeEach(async () => {
    await seedPeople();
    await seedDepartments();
  });

  it("filters aggregated results", async () => {
    const query: DatalogQuery = {
      find: ["?dept", "?count"],
      where: [["?person", ":person/dept", "?dept"]],
      aggregate: [["count", "?person", "?count"]],
      having: [[">=", "?count", 2]],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(1); // Only eng (2 people)
    expect(results[0]!["?dept"]).toBe("d:eng");
  });
});

// ─── ORDER BY ──────────────────────────────────────────────────────────────

describe("ORDER BY", () => {
  beforeEach(seedPeople);

  it("sorts ascending", async () => {
    const query: DatalogQuery = {
      find: ["?name", "?age"],
      where: [
        ["?person", ":person/name", "?name"],
        ["?person", ":person/age", "?age"],
      ],
      orderBy: [{ variable: "?age", direction: "asc" }],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.map((r) => r["?name"])).toEqual(["Bob", "Alice", "Charlie"]);
  });

  it("sorts descending", async () => {
    const query: DatalogQuery = {
      find: ["?name", "?age"],
      where: [
        ["?person", ":person/name", "?name"],
        ["?person", ":person/age", "?age"],
      ],
      orderBy: [{ variable: "?age", direction: "desc" }],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.map((r) => r["?name"])).toEqual(["Charlie", "Alice", "Bob"]);
  });

  it("sorts by string lexicographically", async () => {
    const query: DatalogQuery = {
      find: ["?name"],
      where: [["?person", ":person/name", "?name"]],
      orderBy: [{ variable: "?name", direction: "asc" }],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.map((r) => r["?name"])).toEqual(["Alice", "Bob", "Charlie"]);
  });
});

// ─── LIMIT / OFFSET ───────────────────────────────────────────────────────

describe("LIMIT and OFFSET", () => {
  beforeEach(seedPeople);

  it("limits results", async () => {
    const query: DatalogQuery = {
      find: ["?name"],
      where: [["?person", ":person/name", "?name"]],
      orderBy: [{ variable: "?name" }],
      limit: 2,
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(2);
    expect(results.map((r) => r["?name"])).toEqual(["Alice", "Bob"]);
  });

  it("offsets results", async () => {
    const query: DatalogQuery = {
      find: ["?name"],
      where: [["?person", ":person/name", "?name"]],
      orderBy: [{ variable: "?name" }],
      offset: 1,
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(2);
    expect(results.map((r) => r["?name"])).toEqual(["Bob", "Charlie"]);
  });

  it("limits + offsets together", async () => {
    const query: DatalogQuery = {
      find: ["?name"],
      where: [["?person", ":person/name", "?name"]],
      orderBy: [{ variable: "?name" }],
      limit: 1,
      offset: 1,
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(1);
    expect(results[0]!["?name"]).toBe("Bob");
  });
});

// ─── Wrapped query ─────────────────────────────────────────────────────────

describe("wrapped query", () => {
  beforeEach(seedPeople);

  it("executes inner query with wrapper limit", async () => {
    const query: WrappedQuery = {
      inner: {
        find: ["?name", "?age"],
        where: [
          ["?person", ":person/name", "?name"],
          ["?person", ":person/age", "?age"],
        ],
      },
      orderBy: [{ variable: "?name", direction: "asc" }],
      limit: 2,
    };

    const result = await run(executeWrappedQuery(store, query));
    expect(result.results.length).toBe(2);
  });

  it("includes total count when requested", async () => {
    const query: WrappedQuery = {
      inner: {
        find: ["?name"],
        where: [["?person", ":person/name", "?name"]],
      },
      limit: 2,
      includeCount: true,
    };

    const result = await run(executeWrappedQuery(store, query));
    expect(result.results.length).toBe(2);
    expect(result.totalCount).toBe(3);
  });

  it("applies wrapper filters", async () => {
    const query: WrappedQuery = {
      inner: {
        find: ["?name", "?age"],
        where: [
          ["?person", ":person/name", "?name"],
          ["?person", ":person/age", "?age"],
        ],
      },
      filters: [{ column: "?age", op: ">=", value: 30 }],
    };

    const result = await run(executeWrappedQuery(store, query));
    expect(result.results.length).toBe(2); // Alice (30) and Charlie (35)
  });

  it("applies wrapper like filter", async () => {
    const query: WrappedQuery = {
      inner: {
        find: ["?name"],
        where: [["?person", ":person/name", "?name"]],
      },
      filters: [{ column: "?name", op: "ilike", value: "%li%" }],
    };

    const result = await run(executeWrappedQuery(store, query));
    expect(result.results.length).toBe(2); // Alice, Charlie
  });

  it("applies decoded cursor values for pagination", async () => {
    const query: WrappedQuery = {
      inner: {
        find: ["?name", "?age"],
        where: [
          ["?person", ":person/name", "?name"],
          ["?person", ":person/age", "?age"],
        ],
      },
      orderBy: [{ variable: "?name", direction: "asc" }],
      limit: 3,
    };

    const page1 = await run(executeWrappedQuery(store, query));
    expect(page1.results.length).toBe(3);

    // The Triples boundary owns opaque cursor encoding; the executor consumes
    // only the already-decoded deterministic ordering tuple.
    const page2 = await run(executeWrappedQuery(store, query, [], { cursorValues: ["Bob", 25] }));
    expect(page2.results.length).toBe(1);
    expect(page2.results[0]!["?name"]).toBe("Charlie");
  });
});

// ─── Complex queries ───────────────────────────────────────────────────────

describe("complex queries", () => {
  beforeEach(async () => {
    await seedPeople();
    await seedDepartments();
  });

  it("three-way join with filter", async () => {
    const query: DatalogQuery = {
      find: ["?name", "?deptName"],
      where: [
        ["?person", ":person/name", "?name"],
        ["?person", ":person/age", "?age"],
        ["?person", ":person/dept", "?dept"],
        ["?dept", ":dept/name", "?deptName"],
        [">=", "?age", 30],
      ],
      orderBy: [{ variable: "?name" }],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(2); // Alice (30) and Charlie (35)
    expect(results[0]!["?name"]).toBe("Alice");
    expect(results[0]!["?deptName"]).toBe("Engineering");
    expect(results[1]!["?name"]).toBe("Charlie");
    expect(results[1]!["?deptName"]).toBe("Sales");
  });

  it("empty result from impossible join", async () => {
    const query: DatalogQuery = {
      find: ["?name"],
      where: [
        ["?person", ":person/name", "?name"],
        ["?person", ":nonexistent/attr", "?val"],
      ],
    };

    const { results } = await run(executeQuery(store, query));
    expect(results.length).toBe(0);
  });
});
