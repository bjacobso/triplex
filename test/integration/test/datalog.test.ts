import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  Triples,
  string,
  number,
  ref as makeRef,
  compileWithRules,
  type DatalogQuery,
} from "@triplex-build/triplex/internal";
import { EntityId } from "@triplex-build/triplex";
import { SqliteTestLayer } from "./fixtures/SqliteTestLayer.js";

const TestLayer = SqliteTestLayer;
const eid = EntityId.make;
const ref = (value: string) => makeRef(eid(value));

/**
 * Test data setup:
 *
 * People:
 * - p1: Alice, age 30, status active
 * - p2: Bob, age 25, status inactive
 * - p3: Charlie, age 35 (no status)
 * - p4: James Cameron (director)
 * - p5: Arnold Schwarzenegger (actor)
 *
 * Movies:
 * - m1: The Terminator, director p4, cast p5
 * - m2: Predator, director p6, cast p5
 *
 * - p6: John McTiernan (director)
 */
const setupTestData = Effect.gen(function* () {
  const store = yield* Triples;

  // People
  yield* store.assertBatch([
    { entityId: eid("p1"), attribute: ":name", value: string("Alice"), entityType: "Person" },
    { entityId: eid("p1"), attribute: ":age", value: number(30), entityType: "Person" },
    { entityId: eid("p1"), attribute: ":status", value: string("active"), entityType: "Person" },

    { entityId: eid("p2"), attribute: ":name", value: string("Bob"), entityType: "Person" },
    { entityId: eid("p2"), attribute: ":age", value: number(25), entityType: "Person" },
    { entityId: eid("p2"), attribute: ":status", value: string("inactive"), entityType: "Person" },

    { entityId: eid("p3"), attribute: ":name", value: string("Charlie"), entityType: "Person" },
    { entityId: eid("p3"), attribute: ":age", value: number(35), entityType: "Person" },
    // p3 has no status

    {
      entityId: eid("p4"),
      attribute: ":name",
      value: string("James Cameron"),
      entityType: "Person",
    },
    {
      entityId: eid("p5"),
      attribute: ":name",
      value: string("Arnold Schwarzenegger"),
      entityType: "Person",
    },
    {
      entityId: eid("p6"),
      attribute: ":name",
      value: string("John McTiernan"),
      entityType: "Person",
    },
  ]);

  // Movies
  yield* store.assertBatch([
    {
      entityId: eid("m1"),
      attribute: ":title",
      value: string("The Terminator"),
      entityType: "Movie",
    },
    { entityId: eid("m1"), attribute: ":year", value: number(1984), entityType: "Movie" },
    { entityId: eid("m1"), attribute: ":director", value: ref("p4"), entityType: "Movie" },
    { entityId: eid("m1"), attribute: ":cast", value: ref("p5"), entityType: "Movie" },

    { entityId: eid("m2"), attribute: ":title", value: string("Predator"), entityType: "Movie" },
    { entityId: eid("m2"), attribute: ":year", value: number(1987), entityType: "Movie" },
    { entityId: eid("m2"), attribute: ":director", value: ref("p6"), entityType: "Movie" },
    { entityId: eid("m2"), attribute: ":cast", value: ref("p5"), entityType: "Movie" },
  ]);
});

describe("Datalog Integration", () => {
  describe("simple queries", () => {
    it("should find all names", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query({
            find: ["?name"],
            where: [["?person", ":name", "?name"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results).toHaveLength(6); // Alice, Bob, Charlie, James, Arnold, John
      expect(result.results).toContainEqual({ "?name": "Alice" });
      expect(result.results).toContainEqual({ "?name": "Arnold Schwarzenegger" });
    });

    it("should find by specific value", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query({
            find: ["?person"],
            where: [["?person", ":name", "Alice"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({ "?person": "p1" });
    });

    it("should return multiple attributes", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query({
            find: ["?name", "?age"],
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":age", "?age"],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      // Alice, Bob, Charlie have both name and age
      expect(result.results).toHaveLength(3);
      expect(result.results).toContainEqual({ "?name": "Alice", "?age": 30 });
      expect(result.results).toContainEqual({ "?name": "Bob", "?age": 25 });
      expect(result.results).toContainEqual({ "?name": "Charlie", "?age": 35 });
    });
  });

  describe("predicate filtering", () => {
    it("should filter with >= predicate", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query({
            find: ["?name", "?age"],
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":age", "?age"],
              [">=", "?age", 30],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      // Alice (30) and Charlie (35)
      expect(result.results).toHaveLength(2);
      expect(result.results).toContainEqual({ "?name": "Alice", "?age": 30 });
      expect(result.results).toContainEqual({ "?name": "Charlie", "?age": 35 });
    });

    it("should filter with = predicate", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query({
            find: ["?name"],
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":status", "?status"],
              ["=", "?status", "active"],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({ "?name": "Alice" });
    });

    it("should filter with != predicate", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query({
            find: ["?name"],
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":status", "?status"],
              ["!=", "?status", "active"],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({ "?name": "Bob" });
    });

    it("should filter with < predicate", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query({
            find: ["?name"],
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":age", "?age"],
              ["<", "?age", 30],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      // Only Bob (25)
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({ "?name": "Bob" });
    });
  });

  describe("joins", () => {
    it("should join movie with director", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query({
            find: ["?title", "?directorName"],
            where: [
              ["?movie", ":title", "?title"],
              ["?movie", ":director", "?directorId"],
              ["?directorId", ":name", "?directorName"],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results).toHaveLength(2);
      expect(result.results).toContainEqual({
        "?title": "The Terminator",
        "?directorName": "James Cameron",
      });
      expect(result.results).toContainEqual({
        "?title": "Predator",
        "?directorName": "John McTiernan",
      });
    });

    it("should find Arnold's movies", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query({
            find: ["?title"],
            where: [
              ["?arnold", ":name", "Arnold Schwarzenegger"],
              ["?movie", ":cast", "?arnold"],
              ["?movie", ":title", "?title"],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results).toHaveLength(2);
      expect(result.results).toContainEqual({ "?title": "The Terminator" });
      expect(result.results).toContainEqual({ "?title": "Predator" });
    });

    it("should find Arnold's movies with directors", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query({
            find: ["?title", "?directorName"],
            where: [
              ["?arnold", ":name", "Arnold Schwarzenegger"],
              ["?movie", ":cast", "?arnold"],
              ["?movie", ":title", "?title"],
              ["?movie", ":director", "?directorId"],
              ["?directorId", ":name", "?directorName"],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results).toHaveLength(2);
      expect(result.results).toContainEqual({
        "?title": "The Terminator",
        "?directorName": "James Cameron",
      });
      expect(result.results).toContainEqual({
        "?title": "Predator",
        "?directorName": "John McTiernan",
      });
    });
  });

  describe("typed ref constants", () => {
    it("should match ref values using typed constant", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          // Query movies directed by p4 (James Cameron) using typed ref constant
          return yield* datalog.query({
            find: ["?title"],
            where: [
              ["?movie", ":director", { type: "ref", value: "p4" }],
              ["?movie", ":title", "?title"],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results).toHaveLength(1);
      expect(result.results).toContainEqual({ "?title": "The Terminator" });
    });

    it("should match multiple ref constants", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          // Query movies with cast p5 (Arnold) using typed ref constant
          return yield* datalog.query({
            find: ["?title"],
            where: [
              ["?movie", ":cast", { type: "ref", value: "p5" }],
              ["?movie", ":title", "?title"],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results).toHaveLength(2);
      expect(result.results).toContainEqual({ "?title": "The Terminator" });
      expect(result.results).toContainEqual({ "?title": "Predator" });
    });

    it("should match ref values with plain string constants", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          // Untyped constants match stored values with the same scalar.
          return yield* datalog.query({
            find: ["?title"],
            where: [
              ["?movie", ":director", "p4"],
              ["?movie", ":title", "?title"],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results).toEqual([{ "?title": "The Terminator" }]);
    });
  });

  describe("combined queries", () => {
    it("should join and filter", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          // Find movies from before 1986 with Arnold
          return yield* datalog.query({
            find: ["?title", "?year"],
            where: [
              ["?arnold", ":name", "Arnold Schwarzenegger"],
              ["?movie", ":cast", "?arnold"],
              ["?movie", ":title", "?title"],
              ["?movie", ":year", "?year"],
              ["<", "?year", 1986],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      // Only The Terminator (1984)
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({ "?title": "The Terminator", "?year": 1984 });
    });
  });

  describe("edge cases", () => {
    it("should return empty array for no matches", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query({
            find: ["?person"],
            where: [["?person", ":name", "Nobody"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results).toEqual([]);
    });

    it("should handle query with no results from predicate", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query({
            find: ["?name"],
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":age", "?age"],
              [">", "?age", 100],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results).toEqual([]);
    });
  });

  describe("validation", () => {
    it("should reject invalid query structure", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          // Missing 'where'
          return yield* datalog.query({ find: ["?x"] } as unknown as DatalogQuery);
        }).pipe(Effect.provide(TestLayer), Effect.result),
      );

      expect(result._tag).toBe("Failure");
    });

    it("should treat invalid operator as pattern (returns no matches)", async () => {
      // Note: [">>", "?x", 10] is treated as a pattern clause, not a predicate
      // Since ">>" won't match any attribute in the data, it returns no results
      // This is by design - the schema is permissive, runtime behavior handles edge cases
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query({
            find: ["?name"],
            where: [
              ["?person", ":name", "?name"],
              [">>", "?x", 10], // treated as pattern, not predicate
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      // Returns empty because ">>" doesn't match any attribute
      expect(result.results).toEqual([]);
    });
  });

  describe("negation (not)", () => {
    it("should exclude results matching not pattern", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          // Find people who do NOT have status = "inactive"
          return yield* datalog.query({
            find: ["?name"],
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":status", "?status"],
              ["not", ["?person", ":status", "inactive"]],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      // Only Alice has status and it's not "inactive"
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({ "?name": "Alice" });
    });

    it("should find people without a banned attribute", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          // Find people who have an age but no status
          // First get people with age, then exclude those with status
          return yield* datalog.query({
            find: ["?name"],
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":age", "?age"],
              ["not", ["?person", ":status", "active"]],
              ["not", ["?person", ":status", "inactive"]],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      // Charlie has age but no status at all
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({ "?name": "Charlie" });
    });
  });

  describe("disjunction (or)", () => {
    it("should find entities matching any pattern in or", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          // Find people named Alice OR Bob
          return yield* datalog.query({
            find: ["?name"],
            where: [
              ["?person", ":name", "?name"],
              [
                "or",
                [
                  ["?person", ":name", "Alice"],
                  ["?person", ":name", "Bob"],
                ],
              ],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results).toHaveLength(2);
      expect(result.results).toContainEqual({ "?name": "Alice" });
      expect(result.results).toContainEqual({ "?name": "Bob" });
    });

    it("should work with or on different attributes", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          // Find people who are active OR are 35 years old
          return yield* datalog.query({
            find: ["?name"],
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":age", "?age"],
              [
                "or",
                [
                  ["?person", ":status", "active"],
                  ["?person", ":age", 35],
                ],
              ],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      // Alice (active) and Charlie (age 35)
      expect(result.results).toHaveLength(2);
      expect(result.results).toContainEqual({ "?name": "Alice" });
      expect(result.results).toContainEqual({ "?name": "Charlie" });
    });
  });

  describe("aggregations", () => {
    it("should count entities", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          // Count all people with ages
          return yield* datalog.query({
            find: ["?count"],
            where: [["?person", ":age", "?age"]],
            aggregate: [["count", "?person", "?count"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      // Alice, Bob, Charlie have ages
      expect(result.results).toHaveLength(1);
      expect(result.results[0]["?count"]).toBe(3);
    });

    it("should count with grouping", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          // Count movies per director (implicit GROUP BY)
          return yield* datalog.query({
            find: ["?directorName", "?movieCount"],
            where: [
              ["?movie", ":director", "?directorId"],
              ["?directorId", ":name", "?directorName"],
            ],
            aggregate: [["count", "?movie", "?movieCount"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      // James Cameron (1 movie), John McTiernan (1 movie)
      expect(result.results).toHaveLength(2);
      expect(result.results).toContainEqual({ "?directorName": "James Cameron", "?movieCount": 1 });
      expect(result.results).toContainEqual({
        "?directorName": "John McTiernan",
        "?movieCount": 1,
      });
    });

    it("should count actors across movies", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          // Count how many movies each actor is in
          return yield* datalog.query({
            find: ["?actorName", "?movieCount"],
            where: [
              ["?movie", ":cast", "?actorId"],
              ["?actorId", ":name", "?actorName"],
            ],
            aggregate: [["count", "?movie", "?movieCount"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      // Arnold is in 2 movies
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({
        "?actorName": "Arnold Schwarzenegger",
        "?movieCount": 2,
      });
    });

    it("should sum numeric values", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          // Sum all ages (30 + 25 + 35 = 90)
          return yield* datalog.query({
            find: ["?total"],
            where: [["?person", ":age", "?age"]],
            aggregate: [["sum", "?age", "?total"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0]["?total"]).toBe(90);
    });

    it("should average numeric values", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          // Average age (90 / 3 = 30)
          return yield* datalog.query({
            find: ["?avg"],
            where: [["?person", ":age", "?age"]],
            aggregate: [["avg", "?age", "?avg"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0]["?avg"]).toBe(30);
    });

    it("should find minimum value", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          // Min age = 25 (Bob)
          return yield* datalog.query({
            find: ["?min"],
            where: [["?person", ":age", "?age"]],
            aggregate: [["min", "?age", "?min"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0]["?min"]).toBe(25);
    });

    it("should find maximum value", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          // Max age = 35 (Charlie)
          return yield* datalog.query({
            find: ["?max"],
            where: [["?person", ":age", "?age"]],
            aggregate: [["max", "?age", "?max"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0]["?max"]).toBe(35);
    });

    it("should aggregate with grouping (sum per group)", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          // Sum movie years per director
          return yield* datalog.query({
            find: ["?directorName", "?totalYears"],
            where: [
              ["?movie", ":director", "?directorId"],
              ["?movie", ":year", "?year"],
              ["?directorId", ":name", "?directorName"],
            ],
            aggregate: [["sum", "?year", "?totalYears"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      // James Cameron: 1984, John McTiernan: 1987
      expect(result.results).toHaveLength(2);
      expect(result.results).toContainEqual({
        "?directorName": "James Cameron",
        "?totalYears": 1984,
      });
      expect(result.results).toContainEqual({
        "?directorName": "John McTiernan",
        "?totalYears": 1987,
      });
    });

    it("should support multiple aggregations", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          // Get min, max, and avg ages in one query
          return yield* datalog.query({
            find: ["?minAge", "?maxAge", "?avgAge"],
            where: [["?person", ":age", "?age"]],
            aggregate: [
              ["min", "?age", "?minAge"],
              ["max", "?age", "?maxAge"],
              ["avg", "?age", "?avgAge"],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0]["?minAge"]).toBe(25);
      expect(result.results[0]["?maxAge"]).toBe(35);
      expect(result.results[0]["?avgAge"]).toBe(30);
    });
  });
});

/**
 * Recursive Datalog Queries using CTEs
 *
 * Tests for the compileWithRules functionality that generates
 * recursive CTEs for graph traversal queries.
 */
describe("Recursive Datalog Queries", () => {
  // Layer with SqlClient exposed for recursive query tests
  const RecursiveTestLayer = TestLayer;

  /**
   * Set up a family tree for testing ancestry queries:
   *
   *   grandpa1
   *      |
   *   parent1
   *      |
   *   person1
   *      |
   *    child1
   */
  const setupFamilyTree = Effect.gen(function* () {
    const store = yield* Triples;

    yield* store.assertBatch([
      // Grandpa
      {
        entityId: eid("grandpa1"),
        attribute: ":name",
        value: string("Grandpa Joe"),
        entityType: "Person",
      },

      // Parent (child of grandpa)
      { entityId: eid("parent1"), attribute: ":name", value: string("Dad"), entityType: "Person" },
      {
        entityId: eid("parent1"),
        attribute: ":parent",
        value: string("grandpa1"),
        entityType: "Person",
      },

      // Person (child of parent)
      {
        entityId: eid("person1"),
        attribute: ":name",
        value: string("Alice"),
        entityType: "Person",
      },
      {
        entityId: eid("person1"),
        attribute: ":parent",
        value: string("parent1"),
        entityType: "Person",
      },

      // Child (child of person)
      { entityId: eid("child1"), attribute: ":name", value: string("Baby"), entityType: "Person" },
      {
        entityId: eid("child1"),
        attribute: ":parent",
        value: string("person1"),
        entityType: "Person",
      },
    ]);
  });

  describe("non-recursive rule queries", () => {
    it("should compile and execute a simple non-recursive rule", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupFamilyTree;
          const sql = yield* SqlClient.SqlClient;

          // Define a simple "parent" rule
          const query: DatalogQuery = {
            find: ["?parent"],
            where: [["parent", "person1", "?parent"]],
            rules: [{ name: "parent", body: [["?x", ":parent", "?y"]] }],
          };

          const compiled = compileWithRules(query);
          const rows = yield* sql.unsafe<{ "?parent": string }>(compiled.sql, compiled.params);

          return rows.map((r) => r["?parent"]);
        }).pipe(Effect.provide(RecursiveTestLayer)),
      );

      // person1's parent is parent1
      expect(result).toHaveLength(1);
      expect(result).toContain("parent1");
    });
  });

  describe("recursive rule queries (CTEs)", () => {
    it("should find all ancestors using recursive CTE", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupFamilyTree;
          const sql = yield* SqlClient.SqlClient;

          // Define an "ancestor" rule with recursion
          const query: DatalogQuery = {
            find: ["?ancestor"],
            where: [["ancestor", "person1", "?ancestor"]],
            rules: [
              // Base case: direct parent is an ancestor
              { name: "ancestor", body: [["?x", ":parent", "?y"]] },
              // Recursive case: parent of an ancestor is also an ancestor
              {
                name: "ancestor",
                body: [
                  ["?x", ":parent", "?z"],
                  ["ancestor", "?z", "?y"],
                ],
              },
            ],
          };

          const compiled = compileWithRules(query);
          const rows = yield* sql.unsafe<{ "?ancestor": string }>(compiled.sql, compiled.params);

          return rows.map((r) => r["?ancestor"]);
        }).pipe(Effect.provide(RecursiveTestLayer)),
      );

      // person1's ancestors: parent1 (direct), grandpa1 (via parent1)
      expect(result).toHaveLength(2);
      expect(result).toContain("parent1");
      expect(result).toContain("grandpa1");
    });

    it("should find all descendants using recursive CTE", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupFamilyTree;
          const sql = yield* SqlClient.SqlClient;

          // Define a "child-of" rule to find descendants
          // child_of(Y, X) :- Y has parent X (Y is a child of X)
          // We query child_of(?descendant, grandpa1) to find grandpa1's descendants
          //
          // With the rule body [?y, :parent, ?x], arg1=?y (child), arg2=?x (parent)
          // So child_of(arg1, arg2) means arg1 is a child of arg2
          // Query: child_of(?descendant, grandpa1) means ?descendant is a child of grandpa1
          const query: DatalogQuery = {
            find: ["?descendant"],
            where: [["child_of", "?descendant", "grandpa1"]],
            rules: [
              // Base case: Y is a child of X if Y has X as parent
              // Pattern [?y, :parent, ?x] → arg1=?y (child), arg2=?x (parent)
              { name: "child_of", body: [["?y", ":parent", "?x"]] },
              // Recursive case: Z is a descendant of X if Z is child of Y, and Y is child of X
              {
                name: "child_of",
                body: [
                  ["?z", ":parent", "?y"],
                  ["child_of", "?y", "?x"],
                ],
              },
            ],
          };

          const compiled = compileWithRules(query);
          const rows = yield* sql.unsafe<{ "?descendant": string }>(compiled.sql, compiled.params);

          return rows.map((r) => r["?descendant"]);
        }).pipe(Effect.provide(RecursiveTestLayer)),
      );

      // grandpa1's descendants: parent1 (direct child), person1 (grandchild), child1 (great-grandchild)
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result).toContain("parent1");
    });

    it("should respect maxDepth limit", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupFamilyTree;
          const sql = yield* SqlClient.SqlClient;

          // Limit to depth 0 (only base case - direct parent)
          // depth < 1 means recursive step only runs when current depth is 0, allowing one step
          // depth < 0 would mean no recursion at all, but that would fail the CTE
          // So maxDepth=1 means: base (depth 0) + one recursive level (depth 1)
          const query: DatalogQuery = {
            find: ["?ancestor"],
            where: [["ancestor", "person1", "?ancestor"]],
            rules: [
              { name: "ancestor", body: [["?x", ":parent", "?y"]], maxDepth: 1 },
              {
                name: "ancestor",
                body: [
                  ["?x", ":parent", "?z"],
                  ["ancestor", "?z", "?y"],
                ],
                maxDepth: 1,
              },
            ],
          };

          const compiled = compileWithRules(query);
          const rows = yield* sql.unsafe<{ "?ancestor": string }>(compiled.sql, compiled.params);

          return rows.map((r) => r["?ancestor"]);
        }).pipe(Effect.provide(RecursiveTestLayer)),
      );

      // With maxDepth=1, we get:
      // - Base case (depth 0): person1's parent = parent1
      // - Recursive (depth 1, where r.depth=0 < 1): parent1's parent = grandpa1
      // Total: 2 ancestors
      expect(result).toHaveLength(2);
      expect(result).toContain("parent1");
      expect(result).toContain("grandpa1");
    });
  });

  // =========================================================================
  // Transaction Metadata Tests
  // =========================================================================

  describe("transaction metadata", () => {
    it("should store transaction id when using transact()", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          // Use transact to create triples with shared tx_id
          const { txId, triples } = yield* store.transact(
            [
              { op: "assert", entityId: eid("t1"), attribute: ":name", value: string("Test User") },
              { op: "assert", entityId: eid("t1"), attribute: ":age", value: number(25) },
            ],
            { actor: "admin" },
          );

          // All triples should have the same tx_id
          expect(txId).toBeDefined();
          expect(txId.startsWith("_tx/")).toBe(true);
          expect(triples).toHaveLength(2);
          for (const triple of triples) {
            expect(triple.txId._tag).toBe("Some");
            if (triple.txId._tag === "Some") {
              expect(triple.txId.value).toBe(txId);
            }
          }

          return txId;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toBeDefined();
    });

    it("should create transaction metadata triples", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          // Use transact to create triples with metadata
          const { txId } = yield* store.transact(
            [
              {
                op: "assert",
                entityId: eid("t2"),
                attribute: ":name",
                value: string("Another User"),
              },
            ],
            { actor: "testuser" },
          );

          // Query the transaction metadata
          const txTriples = yield* store.entity(txId as any);

          // Should have :_tx/instant and :_tx/actor triples
          const instantTriple = txTriples.find((t) => t.attribute === ":_tx/instant");
          const actorTriple = txTriples.find((t) => t.attribute === ":_tx/actor");

          expect(instantTriple).toBeDefined();
          expect(instantTriple?.value.type).toBe("datetime");

          expect(actorTriple).toBeDefined();
          expect(actorTriple?.value.type).toBe("string");
          if (actorTriple?.value.type === "string") {
            expect(actorTriple.value.value).toBe("testuser");
          }

          return { txId, instantTriple, actorTriple };
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.txId).toBeDefined();
      expect(result.instantTriple).toBeDefined();
      expect(result.actorTriple).toBeDefined();
    });

    it("should bind transaction in 4-tuple patterns", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const datalog = yield* Triples;

          // Create some data with transactions
          yield* store.transact(
            [
              {
                op: "assert",
                entityId: eid("tx-test-1"),
                attribute: ":name",
                value: string("First"),
              },
            ],
            { actor: "user1" },
          );

          yield* store.transact(
            [
              {
                op: "assert",
                entityId: eid("tx-test-2"),
                attribute: ":name",
                value: string("Second"),
              },
            ],
            { actor: "user2" },
          );

          // Query with 4-tuple pattern to bind tx
          const response = yield* datalog.query({
            find: ["?name", "?tx"],
            where: [["?e", ":name", "?name", "?tx"]],
          });

          // Should have results with tx_id bound
          const txTestResults = response.results.filter(
            (r) => r["?name"] === "First" || r["?name"] === "Second",
          );

          expect(txTestResults.length).toBeGreaterThanOrEqual(2);
          for (const r of txTestResults) {
            expect(r["?tx"]).toBeDefined();
            expect(String(r["?tx"]).startsWith("_tx/")).toBe(true);
          }

          return txTestResults;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it("should query transaction metadata via 4-tuple and join", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const datalog = yield* Triples;

          // Create data with a transaction actor
          yield* store.transact(
            [
              {
                op: "assert",
                entityId: eid("meta-test"),
                attribute: ":name",
                value: string("MetaTest"),
              },
            ],
            { actor: "queryuser" },
          );

          // Query to get name with transaction actor
          const results = yield* datalog.query({
            find: ["?name", "?actor"],
            where: [
              ["?e", ":name", "?name", "?tx"],
              ["?tx", ":_tx/actor", "?actor"],
            ],
          });

          // Find the result for our test entity
          const metaResult = results.results.find((r) => r["?name"] === "MetaTest");

          expect(metaResult).toBeDefined();
          expect(metaResult?.["?actor"]).toBe("queryuser");

          return metaResult;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toBeDefined();
      expect(result?.["?actor"]).toBe("queryuser");
    });

    it("should filter by specific transaction id", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const datalog = yield* Triples;

          // Create two transactions
          const { txId: tx1 } = yield* store.transact([
            { op: "assert", entityId: eid("filter-1"), attribute: ":name", value: string("InTx1") },
          ]);

          const { txId: tx2 } = yield* store.transact([
            { op: "assert", entityId: eid("filter-2"), attribute: ":name", value: string("InTx2") },
          ]);

          // Query for triples in first transaction only
          const response = yield* datalog.query({
            find: ["?name"],
            where: [["?e", ":name", "?name", tx1]],
          });

          const names = response.results.map((r) => r["?name"]);
          expect(names).toContain("InTx1");
          expect(names).not.toContain("InTx2");

          return { tx1, tx2, names };
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.names).toContain("InTx1");
      expect(result.names).not.toContain("InTx2");
    });
  });

  describe("Debug Mode", () => {
    it("should not return debug info by default", async () => {
      const response = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query({
            find: ["?name"],
            where: [["?person", ":name", "?name"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(response.debug).toBeUndefined();
      expect(response.results).toBeDefined();
      expect(response.results.length).toBeGreaterThan(0);
    });

    it("should return debug info when requested", async () => {
      const response = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query(
            {
              find: ["?name"],
              where: [["?person", ":name", "?name"]],
            },
            { debug: true },
          );
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(response.results).toBeDefined();
      expect(response.debug).toBeDefined();
      expect(response.debug?.metrics).toBeDefined();
      expect(response.debug?.executionTimeMs).toBeGreaterThan(0);
      expect(response.debug?.generatedSql).toContain("SELECT");
      expect(response.debug?.resultCount).toBe(response.results.length);
    });

    it("should include compilation metrics in debug mode", async () => {
      const response = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query(
            {
              find: ["?name", "?age"],
              where: [
                ["?person", ":name", "?name"],
                ["?person", ":age", "?age"],
                [">=", "?age", 30],
              ],
            },
            { debug: true },
          );
        }).pipe(Effect.provide(TestLayer)),
      );

      const metrics = response.debug?.metrics;
      expect(metrics).toBeDefined();
      expect(metrics?.patternCount).toBe(2);
      expect(metrics?.predicateCount).toBe(1);
      expect(metrics?.joinCount).toBe(1);
      expect(metrics?.hasAggregation).toBe(false);
      expect(metrics?.compilationTimeMs).toBeGreaterThan(0);
    });

    it("should detect aggregation in debug metrics", async () => {
      const response = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query(
            {
              find: ["?count"],
              where: [["?person", ":name", "?name"]],
              aggregate: [["count", "?person", "?count"]],
            },
            { debug: true },
          );
        }).pipe(Effect.provide(TestLayer)),
      );

      const metrics = response.debug?.metrics;
      expect(metrics?.hasAggregation).toBe(true);
      expect(metrics?.aggregateOps).toContain("count");
    });

    it("should track execution time in debug mode", async () => {
      const response = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query(
            {
              find: ["?name", "?age"],
              where: [
                ["?person", ":name", "?name"],
                ["?person", ":age", "?age"],
              ],
            },
            { debug: true },
          );
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(response.debug?.executionTimeMs).toBeGreaterThan(0);
      expect(response.debug?.executionTimeMs).toBeLessThan(1000); // Sanity check
    });

    it("should include generated SQL and params in debug mode", async () => {
      const response = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query(
            {
              find: ["?name"],
              where: [
                ["?person", ":name", "?name"],
                ["=", "?name", "Alice"],
              ],
            },
            { debug: true },
          );
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(response.debug?.generatedSql).toContain("SELECT DISTINCT");
      expect(response.debug?.generatedSql).toContain("FROM triples");
      expect(response.debug?.params).toContain(":name");
      expect(response.debug?.params).toContain("Alice");
    });

    it("should execute a typed query in debug mode", async () => {
      const response = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query(
            {
              find: ["?name"],
              where: [["?person", ":name", "?name"]],
            },
            { debug: true },
          );
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(response.debug).toBeDefined();
      expect(response.debug?.metrics).toBeDefined();
      expect(response.results).toBeDefined();
    });

    it("should include queryPlan in debug mode", async () => {
      const response = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.query(
            {
              find: ["?name"],
              where: [["?person", ":name", "?name"]],
            },
            { debug: true },
          );
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(response.debug?.queryPlan).toBeDefined();
      expect(response.debug?.queryPlan?.backend).toBe("sqlite");
      expect(response.debug?.queryPlan?.steps).toHaveLength(1);
      expect(response.debug?.queryPlan?.steps[0].label).toBe("main");
      expect(response.debug?.queryPlan?.steps[0].query).toContain("SELECT");
    });
  });

  describe("Explain", () => {
    it("should return query plan without executing", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.explain({
            find: ["?name"],
            where: [["?person", ":name", "?name"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.queryPlan.backend).toBe("sqlite");
      expect(result.queryPlan.steps).toHaveLength(1);
      expect(result.queryPlan.steps[0].label).toBe("main");
      expect(result.queryPlan.steps[0].query).toContain("SELECT DISTINCT");
      expect(result.queryPlan.steps[0].query).toContain("FROM triples");
      expect(result.queryPlan.steps[0].params).toBeDefined();
      expect(result.metrics).toBeDefined();
    });

    it("should include params in query plan steps", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.explain({
            find: ["?name"],
            where: [
              ["?person", ":name", "?name"],
              ["=", "?name", "Alice"],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.queryPlan.steps[0].params).toContain(":name");
      expect(result.queryPlan.steps[0].params).toContain("Alice");
    });

    it("should fail on invalid query", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog
            .explain({ invalid: true } as unknown as DatalogQuery)
            .pipe(Effect.result);
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result._tag).toBe("Failure");
    });

    it("should explain wrapped query with main and count steps", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.explainPage({
            inner: {
              find: ["?name"],
              where: [["?person", ":name", "?name"]],
            },
            orderBy: [{ variable: "?name", direction: "asc" }],
            limit: 10,
            includeCount: true,
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.queryPlan.backend).toBe("sqlite");
      expect(result.queryPlan.steps.length).toBeGreaterThanOrEqual(2);
      expect(result.queryPlan.steps[0].label).toBe("main");
      expect(result.queryPlan.steps[1].label).toBe("count");
      expect(result.queryPlan.steps[1].query).toContain("COUNT");
    });

    it("should explain wrapped query without count when includeCount is absent", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.explainPage({
            inner: {
              find: ["?name"],
              where: [["?person", ":name", "?name"]],
            },
            limit: 10,
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.queryPlan.steps).toHaveLength(1);
      expect(result.queryPlan.steps[0].label).toBe("main");
    });

    it("should generate valid SQL with retracted_at IS NULL filter", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.explain({
            find: ["?name"],
            where: [["?person", ":name", "?name"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      // SQLite queries should always filter out retracted triples
      expect(result.queryPlan.steps[0].query).toContain("retracted_at IS NULL");
    });

    it("should generate SQL with proper joins for multi-pattern queries", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.explain({
            find: ["?name", "?age"],
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":age", "?age"],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      const sql = result.queryPlan.steps[0].query;
      // Multi-pattern queries with shared variable should reference multiple triple aliases
      expect(sql).toContain("t0");
      expect(sql).toContain("t1");
      // Should have attribute params for both patterns
      expect(result.queryPlan.steps[0].params).toContain(":name");
      expect(result.queryPlan.steps[0].params).toContain(":age");
    });

    it("should generate SQL with predicate conditions", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.explain({
            find: ["?name", "?age"],
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":age", "?age"],
              [">=", "?age", 30],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      const sql = result.queryPlan.steps[0].query;
      // Predicate should appear in the SQL as a comparison
      expect(sql).toContain(">=");
    });

    it("should produce SQL that matches actual query results", async () => {
      // Run explain and actual query, verify they produce consistent SQL
      const { plan, queryResult } = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          const plan = yield* datalog.explain({
            find: ["?name"],
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":age", "?age"],
              [">=", "?age", 30],
            ],
          });

          const queryResult = yield* datalog.query(
            {
              find: ["?name"],
              where: [
                ["?person", ":name", "?name"],
                ["?person", ":age", "?age"],
                [">=", "?age", 30],
              ],
            },
            { debug: true },
          );

          return { plan, queryResult };
        }).pipe(Effect.provide(TestLayer)),
      );

      // Explain describes the timeless query shape. Execution additionally
      // resolves the default business-time basis at the read instant.
      expect(plan.queryPlan.steps[0].query).toContain("t0.attribute = ?");
      expect(queryResult.debug?.generatedSql).toContain("t0.valid_from <=");
      expect(queryResult.debug?.generatedSql).toContain("t1.valid_from <=");
      // Temporal instants are emitted as safe numeric literals, so query
      // parameters still describe the same logical filters.
      expect(plan.queryPlan.steps[0].params).toEqual([...(queryResult.debug!.params ?? [])]);
    });

    it("should include compilation metrics", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.explain({
            find: ["?name", "?age"],
            where: [
              ["?person", ":name", "?name"],
              ["?person", ":age", "?age"],
              [">=", "?age", 18],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.metrics).toBeDefined();
      expect(result.metrics!.joinCount).toBeGreaterThanOrEqual(0);
      expect(result.metrics!.patternCount).toBe(2);
      expect(result.metrics!.predicateCount).toBe(1);
      expect(result.metrics!.sqlLength).toBeGreaterThan(0);
      expect(result.metrics!.paramCount).toBeGreaterThan(0);
    });

    it("should explain query with negation", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.explain({
            find: ["?name"],
            where: [
              ["?person", ":name", "?name"],
              ["not", ["?person", ":status", "active"]],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      const sql = result.queryPlan.steps[0].query;
      expect(sql).toContain("NOT EXISTS");
      expect(result.metrics!.notClauseCount).toBe(1);
    });

    it("should explain query with aggregation", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.explain({
            find: ["?avgAge"],
            where: [["?person", ":age", "?age"]],
            aggregate: [["avg", "?age", "?avgAge"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      const sql = result.queryPlan.steps[0].query;
      expect(sql).toContain("AVG");
      expect(result.metrics!.hasAggregation).toBe(true);
    });

    it("should explain wrapped query with ORDER BY and LIMIT in SQL", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.explainPage({
            inner: {
              find: ["?name", "?age"],
              where: [
                ["?person", ":name", "?name"],
                ["?person", ":age", "?age"],
              ],
            },
            orderBy: [{ variable: "?name", direction: "asc" }],
            limit: 5,
            includeCount: true,
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      const mainSql = result.queryPlan.steps[0].query;
      const countSql = result.queryPlan.steps[1].query;

      // Main query should have ORDER BY and LIMIT
      expect(mainSql).toContain("ORDER BY");
      expect(mainSql).toContain("LIMIT");

      // Count query should have COUNT(*) and use the inner CTE
      expect(countSql).toContain("COUNT");

      // Both should share the same CTE structure
      expect(mainSql).toContain("WITH");
      expect(countSql).toContain("WITH");
    });

    it("should explain wrapped query with count params matching main params", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* setupTestData;
          const datalog = yield* Triples;

          return yield* datalog.explainPage({
            inner: {
              find: ["?name"],
              where: [["?person", ":name", "?name"]],
            },
            orderBy: [{ variable: "?name", direction: "asc" }],
            limit: 10,
            includeCount: true,
          });
        }).pipe(Effect.provide(TestLayer)),
      );

      // Count step should also have params (the inner query needs the same bindings)
      const mainParams = result.queryPlan.steps[0].params;
      const countParams = result.queryPlan.steps[1].params;
      expect(mainParams).toBeDefined();
      expect(countParams).toBeDefined();
      // Both share the same inner query, so attribute params should overlap
      expect(mainParams).toContain(":name");
      expect(countParams).toContain(":name");
    });
  });
});
