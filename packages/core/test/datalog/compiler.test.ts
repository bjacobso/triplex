import { describe, it, expect } from "vitest";
import {
  compile,
  compileToSql,
  compileWithRules,
  compileWithRulesToSql,
  tripleBinding,
  ruleBinding,
  resolveBinding,
  isValueLikeBinding,
  parseClause,
  classifyClauses,
} from "../../src/datalog/compiler.js";
import type { DatalogQuery, Clause } from "../../src/datalog/types.js";

describe("Datalog SQL Compiler", () => {
  describe("basic pattern compilation", () => {
    it("should compile a simple pattern query", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?person", ":name", "?name"]],
      };

      const result = compile(query);

      expect(result.sql).toContain("SELECT DISTINCT");
      expect(result.sql).toContain("FROM triples t0");
      expect(result.sql).toContain(`t0.attribute = ?`);
      expect(result.sql).toContain(`AS "?name"`);
      expect(result.columnMap.get("?name")).toBe("?name");
      // Verify params contain the attribute
      expect(result.params).toContain(":name");
    });

    it("should compile query with constant value filter", () => {
      const query: DatalogQuery = {
        find: ["?person"],
        where: [["?person", ":name", "Alice"]],
      };

      const result = compile(query);

      expect(result.sql).toContain(`t0.attribute = ?`);
      expect(result.sql).toContain(`COALESCE(t0.value_string, t0.value_json) = ?`);
      expect(result.sql).toContain(`t0.value_type IN ('string', 'ref', 'blob', 'json')`);
      // Verify params contain the values
      expect(result.params).toContain(":name");
      expect(result.params).toContain("Alice");
    });

    it("should compile query with numeric constant", () => {
      const query: DatalogQuery = {
        find: ["?person"],
        where: [["?person", ":age", 30]],
      };

      const result = compile(query);

      expect(result.sql).toContain(`COALESCE(t0.value_number, t0.value_datetime) = ?`);
      expect(result.sql).toContain(`t0.value_type IN ('number', 'datetime')`);
      // Verify params contain the values
      expect(result.params).toContain(30);
    });

    it("should compile query with boolean constant", () => {
      const query: DatalogQuery = {
        find: ["?person"],
        where: [["?person", ":active", true]],
      };

      const result = compile(query);

      expect(result.sql).toContain(`t0.value_boolean = ?`);
      expect(result.sql).toContain(`t0.value_type = 'boolean'`);
      // Verify params - booleans are stored as 0/1
      expect(result.params).toContain(1);
    });

    it("should compile query with ref typed constant", () => {
      const query: DatalogQuery = {
        find: ["?child"],
        where: [["?child", ":derived-from", { type: "ref", value: "blob:abc123" }]],
      };

      const result = compile(query);

      expect(result.sql).toContain(`t0.value_string = ?`);
      expect(result.sql).toContain(`t0.value_type = ?`);
      expect(result.params).toContain("blob:abc123");
      expect(result.params).toContain("ref");
    });

    it("should compile ref constant in joined pattern", () => {
      const query: DatalogQuery = {
        find: ["?child", "?childName"],
        where: [
          ["?child", ":parent", { type: "ref", value: "person:alice" }],
          ["?child", ":name", "?childName"],
        ],
      };

      const result = compile(query);

      expect(result.sql).toContain(`t0.value_string = ?`);
      expect(result.sql).toContain(`t0.value_type = ?`);
      expect(result.params).toContain("person:alice");
      expect(result.params).toContain("ref");
    });
  });

  describe("join compilation", () => {
    it("should create JOIN for multiple patterns with shared variable", () => {
      const query: DatalogQuery = {
        find: ["?name", "?age"],
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":age", "?age"],
        ],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("FROM triples t0");
      expect(sql).toContain("JOIN triples t1");
      expect(sql).toContain("t1.entity_id = t0.entity_id");
    });

    it("should create ref join (entity to value)", () => {
      const query: DatalogQuery = {
        find: ["?title", "?directorName"],
        where: [
          ["?movie", ":title", "?title"],
          ["?movie", ":director", "?directorId"],
          ["?directorId", ":name", "?directorName"],
        ],
      };

      const sql = compileToSql(query);

      // Should have 3 tables joined
      expect(sql).toContain("t0");
      expect(sql).toContain("t1");
      expect(sql).toContain("t2");
      // Third table should join on the value (ref) of the second table
      expect(sql).toContain("t2.entity_id = COALESCE(t1.value_string, t1.value_json)");
    });

    it("should join a repeated value variable without constraining the entity", () => {
      const query: DatalogQuery = {
        find: ["?parent"],
        where: [
          ["mid", ":child", "?leaf"],
          ["?parent", ":child", "?leaf"],
        ],
      };

      const sql = compileToSql(query);

      expect(sql).toContain(
        "COALESCE(t1.value_number, t1.value_datetime) = COALESCE(t0.value_number, t0.value_datetime)",
      );
      expect(sql).not.toContain("t1.entity_id = t0.value_string");
    });
  });

  describe("predicate compilation", () => {
    it("should compile >= predicate", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":age", "?age"],
          [">=", "?age", 18],
        ],
      };

      const result = compile(query);

      expect(result.sql).toContain("t1.value_type IN ('number', 'datetime')");
      expect(result.sql).toContain("COALESCE(t1.value_number, t1.value_datetime) >= ?");
      expect(result.params).toContain(18);
    });

    it("should compile = predicate", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":status", "?status"],
          ["=", "?status", "active"],
        ],
      };

      const result = compile(query);

      expect(result.sql).toContain("COALESCE(t1.value_string, t1.value_json) = ?");
      expect(result.params).toContain("active");
    });

    it("should compile != predicate", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":status", "?status"],
          ["!=", "?status", "inactive"],
        ],
      };

      const result = compile(query);

      expect(result.sql).toContain(
        "NOT (((t1.value_type IN ('string', 'ref', 'blob', 'json')) AND COALESCE(t1.value_string, t1.value_json) = ?3))",
      );
      expect(result.params).toContain("inactive");
    });

    it("should compile < predicate", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":age", "?age"],
          ["<", "?age", 30],
        ],
      };

      const result = compile(query);

      expect(result.sql).toContain("COALESCE(t1.value_number, t1.value_datetime) < ?");
      expect(result.params).toContain(30);
    });
  });

  describe("not clause compilation", () => {
    it("should compile NOT clause to NOT EXISTS", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [
          ["?person", ":name", "?name"],
          ["not", ["?person", ":banned", true]],
        ],
      };

      const result = compile(query);

      expect(result.sql).toContain("NOT EXISTS");
      expect(result.sql).toContain(`attribute = ?`);
      expect(result.sql).toContain(`value_boolean = ?`);
      expect(result.params).toContain(":banned");
      // Boolean true is converted to 1
      expect(result.params).toContain(1);
    });

    it("should link NOT clause entity to outer query", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [
          ["?person", ":name", "?name"],
          ["not", ["?person", ":status", "inactive"]],
        ],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("entity_id = t0.entity_id");
    });

    it("should compile NOT clause with ref constant", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [
          ["?person", ":name", "?name"],
          ["not", ["?person", ":manager", { type: "ref", value: "emp:root" }]],
        ],
      };

      const result = compile(query);

      expect(result.sql).toContain("NOT EXISTS");
      expect(result.sql).toContain("t1.value_string = ?");
      expect(result.params).toContain("emp:root");
    });
  });

  describe("or clause compilation", () => {
    it("should compile OR clause with multiple patterns", () => {
      const query: DatalogQuery = {
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
      };

      const result = compile(query);

      expect(result.sql).toContain("OR");
      expect(result.sql).toContain("COALESCE(t1.value_string, t1.value_json) = ?");
      expect(result.params).toContain("Alice");
      expect(result.params).toContain("Bob");
    });

    it("should compile OR clause with ref constants", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [
          ["?person", ":name", "?name"],
          [
            "or",
            [
              ["?person", ":manager", { type: "ref", value: "emp:alice" }],
              ["?person", ":manager", { type: "ref", value: "emp:bob" }],
            ],
          ],
        ],
      };

      const result = compile(query);

      expect(result.sql).toContain("OR");
      expect(result.params).toContain("emp:alice");
      expect(result.params).toContain("emp:bob");
    });

    it("should compile OR pattern alternatives as correlated EXISTS filters", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [
          ["?person", ":name", "?name"],
          [
            "or",
            [
              ["?person", ":status", "active"],
              ["?person", ":age", 35],
            ],
          ],
        ],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("EXISTS");
      expect(sql).toContain("entity_id = t0.entity_id");
    });

    it("should compile OR predicate alternatives inline", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":status", "?status"],
          [
            "or",
            [
              ["=", "?status", "offline"],
              ["=", "?status", "degraded"],
            ],
          ],
        ],
      };

      const result = compile(query);

      expect(result.sql).toContain("OR");
      expect(result.sql).toContain("COALESCE(t1.value_string, t1.value_json) = ?");
      expect(result.params).toContain("offline");
      expect(result.params).toContain("degraded");
    });

    it("should compile OR not alternatives as NOT EXISTS filters", () => {
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

      const result = compile(query);

      expect(result.sql).toContain("OR");
      expect(result.sql).toContain("NOT EXISTS");
      expect(result.params).toContain(":workflow-step/input-schema");
      expect(result.params).toContain(":workflow-step/output-schema");
    });
  });

  describe("aggregation compilation", () => {
    it("should compile COUNT aggregation", () => {
      const query: DatalogQuery = {
        find: ["?count"],
        where: [["?person", ":age", "?age"]],
        aggregate: [["count", "?person", "?count"]],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("COUNT(DISTINCT");
      expect(sql).toContain(`AS "?count"`);
    });

    it("should compile SUM aggregation", () => {
      const query: DatalogQuery = {
        find: ["?total"],
        where: [["?person", ":salary", "?salary"]],
        aggregate: [["sum", "?salary", "?total"]],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("SUM(");
      expect(sql).toContain("value_number");
      expect(sql).toContain(`AS "?total"`);
    });

    it("should compile AVG aggregation", () => {
      const query: DatalogQuery = {
        find: ["?average"],
        where: [["?person", ":age", "?age"]],
        aggregate: [["avg", "?age", "?average"]],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("AVG(");
      expect(sql).toContain("value_number");
      expect(sql).toContain(`AS "?average"`);
    });

    it("should compile MIN aggregation", () => {
      const query: DatalogQuery = {
        find: ["?minimum"],
        where: [["?person", ":age", "?age"]],
        aggregate: [["min", "?age", "?minimum"]],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("MIN(");
      expect(sql).toContain("value_number");
      expect(sql).toContain(`AS "?minimum"`);
    });

    it("should compile MAX aggregation", () => {
      const query: DatalogQuery = {
        find: ["?maximum"],
        where: [["?person", ":age", "?age"]],
        aggregate: [["max", "?age", "?maximum"]],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("MAX(");
      expect(sql).toContain("value_number");
      expect(sql).toContain(`AS "?maximum"`);
    });

    it("should compile aggregation with GROUP BY", () => {
      const query: DatalogQuery = {
        find: ["?dept", "?count"],
        where: [["?person", ":department", "?dept"]],
        aggregate: [["count", "?person", "?count"]],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("GROUP BY");
      expect(sql).toContain("COUNT(DISTINCT");
    });

    it("should compile multiple aggregations", () => {
      const query: DatalogQuery = {
        find: ["?dept", "?total", "?avg"],
        where: [
          ["?person", ":department", "?dept"],
          ["?person", ":salary", "?salary"],
        ],
        aggregate: [
          ["sum", "?salary", "?total"],
          ["avg", "?salary", "?avg"],
        ],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("SUM(");
      expect(sql).toContain("AVG(");
      expect(sql).toContain("GROUP BY");
    });
  });

  describe("edge cases", () => {
    it("should reject unbound find variables", () => {
      const query: DatalogQuery = {
        find: ["?unbound"],
        where: [["?person", ":name", "Alice"]],
      };

      expect(() => compile(query)).toThrow("?unbound is not bound by a positive relation");
    });

    it("projects optional fields with nullable correlated subqueries", () => {
      const query: DatalogQuery = {
        find: ["?person", "?status"],
        where: [["?person", ":_schema/type", "Employee"]],
        optionalProjection: {
          rowBinding: "?person",
          fields: [{ attribute: ":employee/status", variable: "?status" }],
        },
      };

      const result = compile(query);
      expect(result.sql).toContain("SELECT COALESCE(");
      expect(result.sql).toContain("opt.attribute = ?");
      expect(result.params.filter((value) => value === ":employee/status")).toHaveLength(1);
    });

    it("should throw for query with no patterns", () => {
      const query: DatalogQuery = {
        find: ["?x"],
        where: [[">=", "?x", 10]], // only predicate, no pattern
      };

      expect(() => compile(query)).toThrow("must contain a positive pattern or rule application");
    });

    it("should use parameterized queries for special characters", () => {
      const query: DatalogQuery = {
        find: ["?person"],
        where: [["?person", ":name", "O'Brien"]],
      };

      const result = compile(query);

      // With parameterized queries, values are passed as params, not embedded in SQL
      expect(result.sql).not.toContain("O'Brien");
      expect(result.sql).toContain("COALESCE(t0.value_string, t0.value_json) = ?");
      // The raw value with special characters is safely passed as a parameter
      expect(result.params).toContain("O'Brien");
    });

    it("should always include retracted_at IS NULL condition", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?person", ":name", "?name"]],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("retracted_at IS NULL");
    });
  });

  describe("columnMap", () => {
    it("should map variable names to column names", () => {
      const query: DatalogQuery = {
        find: ["?name", "?age"],
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":age", "?age"],
        ],
      };

      const result = compile(query);

      expect(result.columnMap.get("?name")).toBe("?name");
      expect(result.columnMap.get("?age")).toBe("?age");
    });

    it("records flattened constant projections for backend-independent decoding", () => {
      const query: DatalogQuery = {
        find: [true, 7, { type: "ref", value: "entity:constant" }, "?name"],
        where: [["?person", ":name", "?name"]],
      };

      const result = compile(query);

      expect([...result.constantColumns.values()]).toEqual([true, 7, "entity:constant"]);
    });
  });

  describe("HAVING clause compilation", () => {
    it("should compile HAVING with aggregate variable", () => {
      const query: DatalogQuery = {
        find: ["?dept", "?count"],
        where: [["?person", ":department", "?dept"]],
        aggregate: [["count", "?person", "?count"]],
        having: [[">=", "?count", 5]],
      };

      const result = compile(query);

      expect(result.sql).toContain("HAVING");
      expect(result.sql).toContain("COUNT(DISTINCT");
      expect(result.sql).toContain(">= ?");
      expect(result.params).toContain(5);
    });

    it("should compile multiple HAVING conditions", () => {
      const query: DatalogQuery = {
        find: ["?status", "?count", "?avg"],
        where: [
          ["?p", ":status", "?status"],
          ["?p", ":value", "?val"],
        ],
        aggregate: [
          ["count", "?p", "?count"],
          ["avg", "?val", "?avg"],
        ],
        having: [
          [">=", "?count", 3],
          ["<", "?avg", 100],
        ],
      };

      const result = compile(query);

      expect(result.sql).toContain("HAVING");
      expect(result.sql).toContain("AND");
      expect(result.sql).toContain(">= ?");
      expect(result.sql).toContain("< ?");
      expect(result.params).toContain(3);
      expect(result.params).toContain(100);
    });

    it("should throw for unbound variable in HAVING", () => {
      const query: DatalogQuery = {
        find: ["?x"],
        where: [["?x", ":name", "?n"]],
        having: [[">=", "?unbound", 5]],
      };

      expect(() => compile(query)).toThrow("having requires at least one aggregate");
    });

    it("should compile HAVING with != operator", () => {
      const query: DatalogQuery = {
        find: ["?dept", "?count"],
        where: [["?person", ":department", "?dept"]],
        aggregate: [["count", "?person", "?count"]],
        having: [["!=", "?count", 0]],
      };

      const result = compile(query);

      expect(result.sql).toContain("HAVING");
      expect(result.sql).toContain("HAVING NOT (COALESCE((COUNT(DISTINCT");
      expect(result.sql).toContain("IS NOT DISTINCT FROM ?");
      expect(result.params).toContain(0);
    });
  });

  describe("ORDER BY clause compilation", () => {
    it("should compile ORDER BY with aggregate variable", () => {
      const query: DatalogQuery = {
        find: ["?dept", "?count"],
        where: [["?p", ":dept", "?dept"]],
        aggregate: [["count", "?p", "?count"]],
        orderBy: [{ variable: "?count", direction: "desc" }],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("ORDER BY");
      expect(sql).toContain("DESC");
    });

    it("should default to ASC direction", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?p", ":name", "?name"]],
        orderBy: [{ variable: "?name" }],
      };

      const sql = compileToSql(query);

      expect(sql).toContain("ORDER BY");
      expect(sql).toContain("ASC");
    });

    it("should compile multiple ORDER BY columns", () => {
      const query: DatalogQuery = {
        find: ["?a", "?b"],
        where: [
          ["?x", ":a", "?a"],
          ["?x", ":b", "?b"],
        ],
        orderBy: [
          { variable: "?a", direction: "asc" },
          { variable: "?b", direction: "desc" },
        ],
      };

      const sql = compileToSql(query);

      expect(sql).toMatch(/ORDER BY.*ASC.*,.*DESC/);
    });

    it("should throw for unbound variable in ORDER BY", () => {
      const query: DatalogQuery = {
        find: ["?x"],
        where: [["?x", ":name", "?n"]],
        orderBy: [{ variable: "?unbound" }],
      };

      expect(() => compile(query)).toThrow("?unbound is not bound by a positive relation");
    });
  });

  describe("LIMIT/OFFSET clause compilation", () => {
    it("should compile LIMIT alone", () => {
      const query: DatalogQuery = {
        find: ["?x"],
        where: [["?x", ":a", "?v"]],
        limit: 10,
      };

      const sql = compileToSql(query);

      expect(sql).toContain("LIMIT 10");
      expect(sql).not.toContain("OFFSET");
    });

    it("should compile LIMIT with OFFSET", () => {
      const query: DatalogQuery = {
        find: ["?x"],
        where: [["?x", ":a", "?v"]],
        limit: 10,
        offset: 20,
      };

      const sql = compileToSql(query);

      expect(sql).toContain("LIMIT 10");
      expect(sql).toContain("OFFSET 20");
    });

    it("should add LIMIT -1 for OFFSET without LIMIT", () => {
      const query: DatalogQuery = {
        find: ["?x"],
        where: [["?x", ":a", "?v"]],
        offset: 5,
      };

      const sql = compileToSql(query);

      expect(sql).toContain("LIMIT -1");
      expect(sql).toContain("OFFSET 5");
    });

    it("should not add OFFSET clause when offset is 0", () => {
      const query: DatalogQuery = {
        find: ["?x"],
        where: [["?x", ":a", "?v"]],
        limit: 10,
        offset: 0,
      };

      const sql = compileToSql(query);

      expect(sql).toContain("LIMIT 10");
      expect(sql).not.toContain("OFFSET");
    });
  });

  describe("combined clauses", () => {
    it("should compile query with all clauses", () => {
      const query: DatalogQuery = {
        find: ["?dept", "?count", "?avgSal"],
        where: [
          ["?e", ":department", "?dept"],
          ["?e", ":salary", "?sal"],
        ],
        aggregate: [
          ["count", "?e", "?count"],
          ["avg", "?sal", "?avgSal"],
        ],
        having: [[">=", "?count", 3]],
        orderBy: [{ variable: "?avgSal", direction: "desc" }],
        limit: 10,
        offset: 5,
      };

      const sql = compileToSql(query);

      expect(sql).toContain("SELECT DISTINCT");
      expect(sql).toContain("GROUP BY");
      expect(sql).toContain("HAVING");
      expect(sql).toContain("ORDER BY");
      expect(sql).toContain("LIMIT 10");
      expect(sql).toContain("OFFSET 5");
    });

    it("should place clauses in correct order", () => {
      const query: DatalogQuery = {
        find: ["?dept", "?count"],
        where: [["?e", ":department", "?dept"]],
        aggregate: [["count", "?e", "?count"]],
        having: [[">=", "?count", 1]],
        orderBy: [{ variable: "?count", direction: "desc" }],
        limit: 5,
      };

      const sql = compileToSql(query);

      // SQL clause order: SELECT, FROM, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT
      const groupByIdx = sql.indexOf("GROUP BY");
      const havingIdx = sql.indexOf("HAVING");
      const orderByIdx = sql.indexOf("ORDER BY");
      const limitIdx = sql.indexOf("LIMIT");

      expect(groupByIdx).toBeLessThan(havingIdx);
      expect(havingIdx).toBeLessThan(orderByIdx);
      expect(orderByIdx).toBeLessThan(limitIdx);
    });
  });
});

describe("Datalog SQL Compiler with Recursive Rules", () => {
  describe("compileWithRules - basic functionality", () => {
    it("should fall back to compile() when no rules provided", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?person", ":name", "?name"]],
      };

      const sql = compileWithRulesToSql(query);

      expect(sql).toContain("SELECT DISTINCT");
      expect(sql).toContain("FROM triples t0");
      expect(sql).not.toContain("WITH RECURSIVE");
    });

    it("should fall back to compile() when rules array is empty", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?person", ":name", "?name"]],
        rules: [],
      };

      const sql = compileWithRulesToSql(query);

      expect(sql).not.toContain("WITH RECURSIVE");
    });
  });

  describe("compileWithRules - CTE generation", () => {
    it("should generate WITH RECURSIVE for non-recursive rule", () => {
      const query: DatalogQuery = {
        find: ["?ancestor"],
        where: [["ancestor", "alice", "?ancestor"]],
        rules: [{ name: "ancestor", body: [["?x", ":parent", "?y"]] }],
      };

      const result = compileWithRules(query);

      expect(result.sql).toContain("WITH RECURSIVE");
      expect(result.sql).toContain("ancestor");
    });

    it("should generate CTE with base case for simple rule", () => {
      const query: DatalogQuery = {
        find: ["?ancestor"],
        where: [["ancestor", "alice", "?ancestor"]],
        rules: [{ name: "ancestor", body: [["?x", ":parent", "?y"]] }],
      };

      const sql = compileWithRulesToSql(query);

      // Should have the rule definition
      expect(sql).toContain("ancestor");
      // Should select arg1 and arg2
      expect(sql).toContain("arg1");
      expect(sql).toContain("arg2");
    });

    it("should handle recursive rule with base case and recursive case", () => {
      const query: DatalogQuery = {
        find: ["?ancestor"],
        where: [["ancestor", "alice", "?ancestor"]],
        rules: [
          // Base case: direct parent
          { name: "ancestor", body: [["?x", ":parent", "?y"]] },
          // Recursive case: parent of ancestor
          {
            name: "ancestor",
            body: [
              ["?x", ":parent", "?z"],
              ["ancestor", "?z", "?y"],
            ],
          },
        ],
      };

      const sql = compileWithRulesToSql(query);

      expect(sql).toContain("WITH RECURSIVE");
      expect(sql).toContain("ancestor");
      expect(sql).toContain("UNION ALL");
      expect(sql).toContain("depth");
    });

    it("should include depth limit in recursive CTE", () => {
      const query: DatalogQuery = {
        find: ["?ancestor"],
        where: [["ancestor", "alice", "?ancestor"]],
        rules: [
          { name: "ancestor", body: [["?x", ":parent", "?y"]], maxDepth: 50 },
          {
            name: "ancestor",
            body: [
              ["?x", ":parent", "?z"],
              ["ancestor", "?z", "?y"],
            ],
            maxDepth: 50,
          },
        ],
      };

      const result = compileWithRules(query);

      // Should have depth < maxDepth condition
      expect(result.sql).toContain("depth");
      expect(result.sql).toContain("depth < ?");
      expect(result.params).toContain(50);
    });

    it("should use default maxDepth of 100", () => {
      const query: DatalogQuery = {
        find: ["?ancestor"],
        where: [["ancestor", "alice", "?ancestor"]],
        rules: [
          { name: "ancestor", body: [["?x", ":parent", "?y"]] },
          {
            name: "ancestor",
            body: [
              ["?x", ":parent", "?z"],
              ["ancestor", "?z", "?y"],
            ],
          },
        ],
      };

      const result = compileWithRules(query);

      expect(result.sql).toContain("depth < ?");
      expect(result.params).toContain(100);
    });
  });

  describe("compileWithRules - rule application in WHERE", () => {
    it("should join rule result in main query", () => {
      const query: DatalogQuery = {
        find: ["?ancestor"],
        where: [["ancestor", "alice", "?ancestor"]],
        rules: [{ name: "ancestor", body: [["?x", ":parent", "?y"]] }],
      };

      const sql = compileWithRulesToSql(query);

      // Should reference the rule CTE
      expect(sql).toContain("ancestor");
      // Should have proper column selection
      expect(sql).toContain("arg1");
      expect(sql).toContain("arg2");
    });

    it("should support rule application with constant argument", () => {
      const query: DatalogQuery = {
        find: ["?ancestor"],
        where: [["ancestor", "alice", "?ancestor"]],
        rules: [{ name: "ancestor", body: [["?x", ":parent", "?y"]] }],
      };

      const result = compileWithRules(query);

      // Constant should be passed as parameter
      expect(result.sql).toContain("arg1 = ?");
      expect(result.params).toContain("alice");
    });

    it("should support mixed patterns and rule applications", () => {
      const query: DatalogQuery = {
        find: ["?name", "?ancestor"],
        where: [
          ["?person", ":name", "?name"],
          ["ancestor", "?person", "?ancestor"],
        ],
        rules: [{ name: "ancestor", body: [["?x", ":parent", "?y"]] }],
      };

      const result = compileWithRules(query);

      expect(result.sql).toContain("WITH RECURSIVE");
      expect(result.sql).toContain("FROM triples t0");
      expect(result.sql).toContain('JOIN "ancestor"');
    });
  });

  describe("compileWithRules - error handling", () => {
    it("should throw when rule has no base case", () => {
      const query: DatalogQuery = {
        find: ["?ancestor"],
        where: [["ancestor", "alice", "?ancestor"]],
        rules: [
          // Only recursive case, no base case
          {
            name: "ancestor",
            body: [
              ["?x", ":parent", "?z"],
              ["ancestor", "?z", "?y"],
            ],
          },
        ],
      };

      expect(() => compileWithRules(query)).toThrow("non-recursive base definition");
    });

    it("should throw when rule body is empty", () => {
      const query: DatalogQuery = {
        find: ["?ancestor"],
        where: [["ancestor", "alice", "?ancestor"]],
        rules: [{ name: "ancestor", body: [] }],
      };

      expect(() => compileWithRules(query)).toThrow("non-empty body");
    });

    it("should reject invalid recursion depths before generating SQL", () => {
      const query: DatalogQuery = {
        find: ["?ancestor"],
        where: [["ancestor", "alice", "?ancestor"]],
        rules: [
          { name: "ancestor", body: [["?x", ":parent", "?y"]], maxDepth: 0 },
          {
            name: "ancestor",
            body: [
              ["?x", ":parent", "?z"],
              ["ancestor", "?z", "?y"],
            ],
          },
        ],
      };

      expect(() => compileWithRules(query)).toThrow("greater than or equal to 1");
    });
  });

  describe("compileWithRules - multiple rules", () => {
    it("should handle multiple different rules", () => {
      const query: DatalogQuery = {
        find: ["?person"],
        where: [
          ["parent", "alice", "?person"],
          ["sibling", "?person", "?sibling"],
        ],
        rules: [
          { name: "parent", body: [["?x", ":parent", "?y"]] },
          {
            name: "sibling",
            body: [
              ["?parent", ":parent", "?x"],
              ["?parent", ":parent", "?y"],
            ],
          },
        ],
      };

      const sql = compileWithRulesToSql(query);

      // Should have both CTEs
      expect(sql).toContain("parent");
      expect(sql).toContain("sibling");
    });
  });

  describe("Query Metrics (Debug Mode)", () => {
    it("should not include metrics by default", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?person", ":name", "?name"]],
      };

      const result = compile(query);

      expect(result.metrics).toBeUndefined();
    });

    it("should include metrics when requested", () => {
      const query: DatalogQuery = {
        find: ["?name"],
        where: [["?person", ":name", "?name"]],
      };

      const result = compile(query, undefined, true);

      expect(result.metrics).toBeDefined();
      expect(result.metrics?.patternCount).toBe(1);
      expect(result.metrics?.predicateCount).toBe(0);
      expect(result.metrics?.joinCount).toBe(0);
      expect(result.metrics?.hasAggregation).toBe(false);
      expect(result.metrics?.isRecursive).toBe(false);
      expect(result.metrics?.compilationTimeMs).toBeGreaterThan(0);
    });

    it("should count joins correctly", () => {
      const query: DatalogQuery = {
        find: ["?name", "?age"],
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":age", "?age"],
        ],
      };

      const result = compile(query, undefined, true);

      expect(result.metrics?.patternCount).toBe(2);
      expect(result.metrics?.joinCount).toBe(1);
      expect(result.metrics?.whereConditionCount).toBeGreaterThan(0);
    });

    it("should count predicates", () => {
      const query: DatalogQuery = {
        find: ["?name", "?age"],
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":age", "?age"],
          [">=", "?age", 18],
        ],
      };

      const result = compile(query, undefined, true);

      expect(result.metrics?.patternCount).toBe(2);
      expect(result.metrics?.predicateCount).toBe(1);
    });

    it("should detect aggregations", () => {
      const query: DatalogQuery = {
        find: ["?count"],
        where: [["?person", ":name", "?name"]],
        aggregate: [["count", "?person", "?count"]],
      };

      const result = compile(query, undefined, true);

      expect(result.metrics?.hasAggregation).toBe(true);
      expect(result.metrics?.aggregateOps).toEqual(["count"]);
    });

    it("should count NOT clauses as subqueries", () => {
      const query: DatalogQuery = {
        find: ["?person"],
        where: [
          ["?person", ":name", "?name"],
          ["not", ["?person", ":banned", true]],
        ],
      };

      const result = compile(query, undefined, true);

      expect(result.metrics?.notClauseCount).toBe(1);
      expect(result.metrics?.subqueryCount).toBe(1);
    });

    it("should count OR clauses", () => {
      const query: DatalogQuery = {
        find: ["?person"],
        where: [
          ["?person", ":name", "?name"],
          [
            "or",
            [
              ["?person", ":role", "admin"],
              ["?person", ":role", "moderator"],
            ],
          ],
        ],
      };

      const result = compile(query, undefined, true);

      expect(result.metrics?.orClauseCount).toBe(1);
    });

    it("should track SQL length and param count", () => {
      const query: DatalogQuery = {
        find: ["?name", "?age", "?email"],
        where: [
          ["?person", ":name", "?name"],
          ["?person", ":age", "?age"],
          ["?person", ":email", "?email"],
          [">=", "?age", 18],
        ],
      };

      const result = compile(query, undefined, true);

      expect(result.metrics?.sqlLength).toBeGreaterThan(100);
      expect(result.metrics?.paramCount).toBeGreaterThan(3);
    });

    it("should mark recursive queries in compileWithRules", () => {
      const query: DatalogQuery = {
        find: ["?ancestor"],
        where: [["ancestor", "alice", "?ancestor"]],
        rules: [
          {
            name: "ancestor",
            body: [["?x", ":parent", "?y"]],
          },
          {
            name: "ancestor",
            body: [
              ["?x", ":parent", "?z"],
              ["ancestor", "?z", "?y"],
            ],
          },
        ],
      };

      const result = compileWithRules(query, undefined, true);

      expect(result.metrics?.isRecursive).toBe(true);
      expect(result.metrics?.cteCount).toBe(1);
    });

    it("should track multiple aggregate operations", () => {
      const query: DatalogQuery = {
        find: ["?count", "?avg"],
        where: [["?person", ":age", "?age"]],
        aggregate: [
          ["count", "?person", "?count"],
          ["avg", "?age", "?avg"],
        ],
      };

      const result = compile(query, undefined, true);

      expect(result.metrics?.hasAggregation).toBe(true);
      expect(result.metrics?.aggregateOps).toContain("count");
      expect(result.metrics?.aggregateOps).toContain("avg");
    });
  });
});

describe("Compiler Internals", () => {
  describe("resolveBinding", () => {
    it("should resolve Triple entity binding", () => {
      expect(resolveBinding(tripleBinding("t0", "entity"))).toBe("t0.entity_id");
    });

    it("should resolve Triple attribute binding", () => {
      expect(resolveBinding(tripleBinding("t0", "attribute"))).toBe("t0.attribute");
    });

    it("should resolve Triple tx binding", () => {
      expect(resolveBinding(tripleBinding("t0", "tx"))).toBe("t0.tx_id");
    });

    it("should resolve Triple value binding with raw mode (default)", () => {
      expect(resolveBinding(tripleBinding("t0", "value"))).toBe("t0.value_string");
    });

    it("should resolve Triple value binding with string mode", () => {
      expect(resolveBinding(tripleBinding("t0", "value"), { valueMode: "string" })).toBe(
        "t0.value_string",
      );
    });

    it("should resolve Triple value binding with number mode", () => {
      expect(resolveBinding(tripleBinding("t0", "value"), { valueMode: "number" })).toBe(
        "COALESCE(t0.value_number, t0.value_datetime)",
      );
    });

    it("should resolve Triple value binding with boolean mode", () => {
      expect(resolveBinding(tripleBinding("t0", "value"), { valueMode: "boolean" })).toBe(
        "t0.value_boolean",
      );
    });

    it("should resolve Triple value binding with coalesce mode", () => {
      const result = resolveBinding(tripleBinding("t0", "value"), { valueMode: "coalesce" });
      expect(result).toBe(
        "COALESCE(t0.value_string, CAST(t0.value_number AS TEXT), CAST(t0.value_boolean AS TEXT), CAST(t0.value_datetime AS TEXT), t0.value_json)",
      );
    });

    it("should resolve Rule binding for arg1", () => {
      expect(resolveBinding(ruleBinding("ancestor_ref0", "arg1"))).toBe("ancestor_ref0.arg1");
    });

    it("should resolve Rule binding for arg2", () => {
      expect(resolveBinding(ruleBinding("ancestor_ref0", "arg2"))).toBe("ancestor_ref0.arg2");
    });

    it("should cast Rule binding to REAL for number mode", () => {
      expect(resolveBinding(ruleBinding("r0", "arg2"), { valueMode: "number" })).toBe(
        "CAST(r0.arg2 AS REAL)",
      );
    });

    it("should not cast Rule binding for string mode", () => {
      expect(resolveBinding(ruleBinding("r0", "arg1"), { valueMode: "string" })).toBe("r0.arg1");
    });

    it("should not coalesce Rule binding for coalesce mode", () => {
      expect(resolveBinding(ruleBinding("r0", "arg2"), { valueMode: "coalesce" })).toBe("r0.arg2");
    });
  });

  describe("isValueLikeBinding", () => {
    it("should return true for Triple value binding", () => {
      expect(isValueLikeBinding(tripleBinding("t0", "value"))).toBe(true);
    });

    it("should return true for Rule arg2 binding", () => {
      expect(isValueLikeBinding(ruleBinding("r0", "arg2"))).toBe(true);
    });

    it("should return false for Triple entity binding", () => {
      expect(isValueLikeBinding(tripleBinding("t0", "entity"))).toBe(false);
    });

    it("should return false for Triple attribute binding", () => {
      expect(isValueLikeBinding(tripleBinding("t0", "attribute"))).toBe(false);
    });

    it("should return false for Triple tx binding", () => {
      expect(isValueLikeBinding(tripleBinding("t0", "tx"))).toBe(false);
    });

    it("should return false for Rule arg1 binding", () => {
      expect(isValueLikeBinding(ruleBinding("r0", "arg1"))).toBe(false);
    });
  });

  describe("parseClause", () => {
    it("should parse a pattern clause", () => {
      const clause: Clause = ["?person", ":name", "?name"];
      const result = parseClause(clause, { allowRuleApplications: false });
      expect(result._tag).toBe("Pattern");
    });

    it("should parse a 4-element pattern clause (with tx)", () => {
      const clause: Clause = ["?person", ":name", "?name", "?tx"];
      const result = parseClause(clause, { allowRuleApplications: false });
      expect(result._tag).toBe("Pattern");
    });

    it("should parse a predicate clause", () => {
      const clause: Clause = [">=", "?age", 18];
      const result = parseClause(clause, { allowRuleApplications: false });
      expect(result._tag).toBe("Predicate");
    });

    it("should parse all predicate operators", () => {
      for (const op of [">", ">=", "<", "<=", "=", "!="]) {
        const clause: Clause = [op, "?x", 1] as Clause;
        const result = parseClause(clause, { allowRuleApplications: false });
        expect(result._tag).toBe("Predicate");
      }
    });

    it("should parse a not clause", () => {
      const clause: Clause = ["not", ["?person", ":banned", true]];
      const result = parseClause(clause, { allowRuleApplications: false });
      expect(result._tag).toBe("Not");
    });

    it("should parse an or clause", () => {
      const clause: Clause = [
        "or",
        [
          ["?person", ":name", "Alice"],
          ["?person", ":name", "Bob"],
        ],
      ];
      const result = parseClause(clause, { allowRuleApplications: false });
      expect(result._tag).toBe("Or");
    });

    it("should parse a flat or clause into canonical alternatives", () => {
      const clause = [
        "or",
        ["=", "?status", "offline"],
        ["not", ["?step", ":workflow-step/output-schema", "?os"]],
      ] as unknown as Clause;
      const result = parseClause(clause, { allowRuleApplications: false });
      expect(result._tag).toBe("Or");
      if (result._tag === "Or") {
        expect(result.orClause[1]).toHaveLength(2);
      }
    });

    it("should parse a rule application when allowed", () => {
      const clause: Clause = ["ancestor", "?x", "?y"];
      const result = parseClause(clause, { allowRuleApplications: true });
      expect(result._tag).toBe("RuleCall");
    });

    it("should throw for rule application when not allowed", () => {
      const clause: Clause = ["ancestor", "?x", "?y"];
      expect(() => parseClause(clause, { allowRuleApplications: false })).toThrow(
        'Rule application "ancestor" requires compileWithRules()',
      );
    });

    it("should throw for predicate with wrong arity", () => {
      const clause = [">", "?x"] as unknown as Clause;
      expect(() => parseClause(clause, { allowRuleApplications: false })).toThrow(
        "Invalid predicate clause arity",
      );
    });

    it("should throw for not clause with wrong arity", () => {
      const clause = ["not"] as unknown as Clause;
      expect(() => parseClause(clause, { allowRuleApplications: false })).toThrow(
        "Invalid not clause arity",
      );
    });

    it("should throw for or clause with wrong arity", () => {
      const clause = ["or"] as unknown as Clause;
      expect(() => parseClause(clause, { allowRuleApplications: false })).toThrow(
        "Invalid or clause arity",
      );
    });

    it("should throw for clause with too few elements", () => {
      const clause = ["?x", ":a"] as unknown as Clause;
      expect(() => parseClause(clause, { allowRuleApplications: false })).toThrow(
        "Invalid clause arity",
      );
    });

    it("should throw for clause with too many elements", () => {
      const clause = ["?x", ":a", "?v", "?tx", "extra"] as unknown as Clause;
      expect(() => parseClause(clause, { allowRuleApplications: false })).toThrow(
        "Invalid clause arity",
      );
    });
  });

  describe("classifyClauses", () => {
    it("should classify mixed clause types", () => {
      const where: Clause[] = [
        ["?person", ":name", "?name"],
        ["?person", ":age", "?age"],
        [">=", "?age", 18],
        ["not", ["?person", ":banned", true]],
        [
          "or",
          [
            ["?person", ":role", "admin"],
            ["?person", ":role", "mod"],
          ],
        ],
      ];

      const result = classifyClauses(where, { allowRuleApplications: false });

      expect(result.patterns).toHaveLength(2);
      expect(result.predicates).toHaveLength(1);
      expect(result.notClauses).toHaveLength(1);
      expect(result.orClauses).toHaveLength(1);
      expect(result.ruleApplications).toHaveLength(0);
    });

    it("should classify rule applications when allowed", () => {
      const where: Clause[] = [
        ["?person", ":name", "?name"],
        ["ancestor", "?person", "?anc"],
      ];

      const result = classifyClauses(where, { allowRuleApplications: true });

      expect(result.patterns).toHaveLength(1);
      expect(result.ruleApplications).toHaveLength(1);
    });

    it("should return empty arrays for empty where", () => {
      const result = classifyClauses([], { allowRuleApplications: false });

      expect(result.patterns).toHaveLength(0);
      expect(result.predicates).toHaveLength(0);
      expect(result.notClauses).toHaveLength(0);
      expect(result.orClauses).toHaveLength(0);
      expect(result.ruleApplications).toHaveLength(0);
    });
  });

  describe("rule application error via compile()", () => {
    it("should throw when rule application is used in compile() instead of compileWithRules()", () => {
      const query: DatalogQuery = {
        find: ["?ancestor"],
        where: [["ancestor", "alice", "?ancestor"]],
      };

      expect(() => compile(query)).toThrow("has no definition");
    });
  });
});
