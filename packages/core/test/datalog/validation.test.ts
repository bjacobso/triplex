import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { DatalogValidationError, UnboundVariableError } from "../../src/errors/index.js";
import {
  assertDatalogQuery,
  assertWrappedQuery,
  validateDatalogQuery,
} from "../../src/datalog/validation.js";

describe("Datalog query validation", () => {
  it("accepts declarative clause order and constant-only relations", () => {
    expect(
      assertDatalogQuery({
        find: ["?entity"],
        where: [
          [">=", "?score", 10],
          ["?entity", ":score", "?score"],
        ],
      }).find,
    ).toEqual(["?entity"]);

    expect(
      assertDatalogQuery({
        find: ["matched"],
        where: [["entity:1", ":status", "active"]],
      }).find,
    ).toEqual(["matched"]);
  });

  it("turns malformed runtime input into a typed validation failure", async () => {
    const failure = await Effect.runPromise(
      validateDatalogQuery({ find: ["?entity"], where: "not-an-array" }).pipe(Effect.flip),
    );

    expect(failure).toBeInstanceOf(DatalogValidationError);
    expect(failure.message).toContain("Invalid Datalog query shape");
  });

  it("explains and-grouping and multi-clause or alternatives", () => {
    const base = ["?v", ":v/name", "?n"];
    const cases: ReadonlyArray<readonly [unknown, RegExp]> = [
      [
        [
          "or",
          [
            [
              ["?v", ":v/a", true],
              ["?v", ":v/b", true],
            ],
            [["?v", ":v/c", true]],
          ],
        ],
        /where\[1\] alternative 0: each "or" alternative must be a single pattern, predicate, or "not" clause/,
      ],
      [
        [
          "or",
          [
            ["and", ["?v", ":v/a", true], ["?v", ":v/b", true]],
            ["?v", ":v/c", true],
          ],
        ],
        /where\[1\] alternative 0: each "or" alternative must be a single/,
      ],
      [
        ["not", ["and", ["?r", ":r/vendor", "?v"], ["?r", ":r/ok", true]]],
        /where\[1\]: write conjunctive negation as \["not", clause1, clause2, \.\.\.\]/,
      ],
      [["and", ["?v", ":v/a", true]], /where\[1\]: Datalog has no "and" clause/],
    ];
    for (const [clause, message] of cases) {
      const query = { find: ["?v"], where: [base, clause] };
      expect(() => assertDatalogQuery(query)).toThrow(DatalogValidationError);
      expect(() => assertDatalogQuery(query)).toThrow(message);
    }

    expect(
      assertDatalogQuery({
        find: ["?v"],
        where: [base, ["not", ["?r", ":r/vendor", "?v"], ["?r", ":r/ok", true]]],
      }).where,
    ).toHaveLength(2);
    expect(
      assertDatalogQuery({
        find: ["?v"],
        where: [
          base,
          [
            "or",
            [
              ["not", ["?r", ":r/vendor", "?v"], ["?r", ":r/ok", true]],
              ["?v", ":v/c", true],
            ],
          ],
        ],
      }).where,
    ).toHaveLength(2);
  });

  it("reports unbound result and predicate variables explicitly", () => {
    for (const query of [
      {
        find: ["?missing"],
        where: [["?entity", ":status", "active"]],
      },
      {
        find: ["?entity"],
        where: [
          ["?entity", ":status", "active"],
          ["=", "?missing", true],
        ],
      },
    ]) {
      expect(() => assertDatalogQuery(query)).toThrow(UnboundVariableError);
      try {
        assertDatalogQuery(query);
      } catch (error) {
        expect((error as UnboundVariableError).variable).toBe("?missing");
      }
    }
  });

  it("rejects ambiguous result and aggregate bindings", () => {
    expect(() =>
      assertDatalogQuery({
        find: ["?entity", "?entity"],
        where: [["?entity", ":score", "?score"]],
      }),
    ).toThrow("projected more than once");

    expect(() =>
      assertDatalogQuery({
        find: ["?score", "?total"],
        where: [["?entity", ":score", "?score"]],
        aggregate: [["sum", "?score", "?total"]],
      }),
    ).toThrow("aggregate source ?score cannot also appear in find");

    expect(() =>
      assertDatalogQuery({
        find: ["?entity"],
        where: [["?entity", ":score", "?score"]],
        aggregate: [["sum", "?score", "?total"]],
      }),
    ).toThrow("aggregate target ?total must appear in find");
  });

  it("restricts having and ordering to actual result bindings", () => {
    expect(() =>
      assertDatalogQuery({
        find: ["?entity"],
        where: [["?entity", ":score", "?score"]],
        having: [[">", "?score", 10]],
      }),
    ).toThrow("having requires at least one aggregate");

    expect(() =>
      assertDatalogQuery({
        find: ["?entity"],
        where: [["?entity", ":score", "?score"]],
        orderBy: [{ variable: "?score" }],
      }),
    ).toThrow(UnboundVariableError);
  });

  it("keeps aggregate equality numeric and rejects post-query optional targets", () => {
    expect(
      assertDatalogQuery({
        find: ["?bucket", "?count"],
        where: [["?entity", ":bucket", "?bucket"]],
        aggregate: [["count", "?entity", "?count"]],
        having: [
          ["=", "?bucket", "seven"],
          ["=", "?count", 2],
        ],
      }).find,
    ).toEqual(["?bucket", "?count"]);

    expect(() =>
      assertDatalogQuery({
        find: ["?count"],
        where: [["?entity", ":bucket", "?bucket"]],
        aggregate: [["count", "?entity", "?count"]],
        having: [["=", "?count", "2"]],
      }),
    ).toThrow("aggregate equality constants must be numeric");

    expect(() =>
      assertDatalogQuery({
        find: ["?entity", "?count"],
        where: [["?entity", ":bucket", "?bucket"]],
        aggregate: [["count", "?bucket", "?count"]],
        having: [["=", "?count", "?entity"]],
      }),
    ).toThrow("aggregate equality operand ?entity must be numeric");

    expect(() =>
      assertDatalogQuery({
        find: ["?bucket", "?label", "?count"],
        where: [["?entity", ":bucket", "?bucket"]],
        aggregate: [["count", "?entity", "?count"]],
        optionalProjection: {
          rowBinding: "?entity",
          fields: [{ attribute: ":label", variable: "?label" }],
        },
        having: [["=", "?label", "featured"]],
      }),
    ).toThrow("having cannot reference optional projection target ?label");
  });

  it("restricts ordered predicates to numeric-capable value bindings and constants", () => {
    expect(() =>
      assertDatalogQuery({
        find: ["?entity"],
        where: [
          ["?entity", ":score", "?score"],
          [">", "?entity", "entity:0"],
        ],
      }),
    ).toThrow("must be bound from a value");

    expect(() =>
      assertDatalogQuery({
        find: ["?entity"],
        where: [
          ["?entity", ":score", "?score"],
          [">", "?score", "10"],
        ],
      }),
    ).toThrow("constants must be numeric");

    expect(
      assertDatalogQuery({
        find: ["?entity"],
        where: [
          ["?entity", ":score", "?score"],
          [">", "?score", 10],
        ],
      }).find,
    ).toEqual(["?entity"]);
  });

  it("rejects optional projections that shadow or omit result bindings", () => {
    expect(() =>
      assertDatalogQuery({
        find: ["?entity"],
        where: [["?entity", ":status", "?status"]],
        optionalProjection: {
          rowBinding: "?entity",
          fields: [{ attribute: ":label", variable: "?status" }],
        },
      }),
    ).toThrow("shadows another binding");

    expect(() =>
      assertDatalogQuery({
        find: ["?entity"],
        where: [["?entity", ":status", "?status"]],
        optionalProjection: {
          rowBinding: "?entity",
          fields: [{ attribute: ":label", variable: "?label" }],
        },
      }),
    ).toThrow("target ?label must appear in find");
  });

  it("rejects empty disjunctions and undefined rules", () => {
    expect(() =>
      assertDatalogQuery({
        find: ["?entity"],
        where: [
          ["?entity", ":status", "active"],
          ["or", []],
        ],
      }),
    ).toThrow("at least one alternative");

    expect(() =>
      assertDatalogQuery({
        find: ["?ancestor"],
        where: [["ancestor", "entity:1", "?ancestor"]],
      }),
    ).toThrow("has no definition");
  });

  it("rejects recursive rule bodies the shared engines cannot execute identically", () => {
    expect(() =>
      assertDatalogQuery({
        find: ["?ancestor"],
        where: [["ancestor", "entity:1", "?ancestor"]],
        rules: [
          { name: "ancestor", body: [["?head", ":parent", "?tail"]] },
          {
            name: "ancestor",
            body: [
              ["?head", ":parent", "?middle"],
              ["?middle", ":enabled", "?enabled"],
              ["ancestor", "?middle", "?tail"],
            ],
          },
        ],
      }),
    ).toThrow("must be [head, attribute, next]");
  });

  it("requires wrapped filters and ordering to reference inner projections", () => {
    expect(() =>
      assertWrappedQuery({
        inner: {
          find: ["?entity"],
          where: [["?entity", ":score", "?score"]],
        },
        filters: [{ column: "?score", op: ">", value: 10 }],
      }),
    ).toThrow(UnboundVariableError);

    expect(() =>
      assertWrappedQuery({
        inner: {
          find: ["?entity"],
          where: [["?entity", ":score", "?score"]],
        },
        orderBy: [{ variable: "?score" }],
      }),
    ).toThrow(UnboundVariableError);
  });

  it("requires canonical wrapper filter operands", () => {
    const inner = {
      find: ["?entity", "?value"],
      where: [["?entity", ":value", "?value"]],
    } as const;

    expect(() => assertWrappedQuery({ inner, filters: [{ column: "?value", op: "=" }] })).toThrow(
      "requires a value",
    );
    expect(() =>
      assertWrappedQuery({
        inner,
        filters: [{ column: "?value", op: "is-null", value: "unused" }],
      }),
    ).toThrow("must not include a value");
    expect(() =>
      assertWrappedQuery({ inner, filters: [{ column: "?value", op: "like", value: 42 }] }),
    ).toThrow("requires a string value");
    expect(() =>
      assertWrappedQuery({ inner, filters: [{ column: "?value", op: ">", value: true }] }),
    ).toThrow("requires a number or string value");
  });

  it("requires numeric operands for aggregate-result filters", () => {
    expect(() =>
      assertWrappedQuery({
        inner: {
          find: ["?count"],
          where: [["?entity", ":value", "?value"]],
          aggregate: [["count", "?entity", "?count"]],
        },
        filters: [{ column: "?count", op: "=", value: "1" }],
      }),
    ).toThrow("requires a numeric value");
  });
});
