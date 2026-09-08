/**
 * Datalog Module
 *
 * Datalog is a declarative query language for graph traversal and pattern matching.
 */

import { Schema } from "effect";

// =============================================================================
// Primitive Terms
// =============================================================================

/**
 * Variable: a string starting with "?" followed by an identifier
 * Examples: "?person", "?age", "?movieTitle"
 */
export const Variable = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\?[a-zA-Z_][a-zA-Z0-9_]*$/)),
  Schema.annotate({
    identifier: "Variable",
    description: "A Datalog variable starting with ? (e.g., ?person, ?age)",
  }),
);

/**
 * DatalogAttribute: a string starting with ":" followed by an identifier
 * Examples: ":name", ":age", ":movie/title"
 *
 * Note: Named DatalogAttribute to avoid conflict with shared/Branded.ts Attribute type.
 */
export const DatalogAttribute = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^:[a-zA-Z_][a-zA-Z0-9_/-]*$/)),
  Schema.annotate({
    identifier: "DatalogAttribute",
    description: "An attribute starting with : (e.g., :name, :movie/title)",
  }),
);

/**
 * TypedConstant: a constant with an explicit type (e.g. ref values)
 * Matches the internal TripleValue representation { type, value }
 */
export const TypedConstant = Schema.Struct({
  type: Schema.Literal("ref"),
  value: Schema.String,
}).annotate({
  identifier: "TypedConstant",
  description: "A typed constant value (e.g. { type: 'ref', value: 'entity:id' })",
});
export type TypedConstant = typeof TypedConstant.Type;

/**
 * Check if a value is a typed constant (object with type field)
 */
export const isTypedConstant = (value: unknown): value is TypedConstant =>
  typeof value === "object" && value !== null && "type" in value;

/**
 * Constant: a literal value (string, number, boolean, or typed constant)
 */
const LiteralString = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(?!\?)[\s\S]*$/)),
  Schema.annotate({
    identifier: "DatalogLiteralString",
    description: "A string literal that does not use the reserved ? variable prefix",
  }),
);

export const Constant = Schema.Union([
  LiteralString,
  Schema.Number,
  Schema.Boolean,
  TypedConstant,
]).annotate({
  identifier: "Constant",
  description: "A constant value (string, number, boolean, or typed constant like ref)",
});

/**
 * Term: either a variable or a constant
 */
export const Term = Schema.Union([Variable, Constant]).annotate({
  identifier: "Term",
  description: "A term that is either a variable (?x) or a constant value",
});

/**
 * Entity, attribute, and transaction positions are identities. Triplex stores
 * every identity as text, so these positions accept only a string literal or
 * variable; typed refs belong in the value position.
 */
const IdentityTerm = Schema.Union([Variable, LiteralString]).annotate({
  identifier: "IdentityTerm",
  description: "A string identity literal or Datalog variable",
});

// =============================================================================
// Clause Types
// =============================================================================

/**
 * Predicate operators. Equality compares compatible flattened scalar families;
 * ordered comparisons are numeric-only and accept number/datetime value bindings.
 */
export const PredicateOp = Schema.Literals([">", ">=", "<", "<=", "=", "!="]).annotate({
  identifier: "PredicateOp",
  description: "Equality or numeric ordered-comparison operator for predicates",
});

/**
 * Pattern clause: [entity, attribute, value] or [entity, attribute, value, tx]
 * Used for matching triples in the database
 * The optional 4th element binds to the transaction that created the triple.
 *
 * Examples:
 * - ["?person", ":name", "Alice"]           // 3-tuple
 * - ["?movie", ":director", "?director"]    // 3-tuple
 * - ["?e", ":name", "?n", "?tx"]            // 4-tuple with tx binding
 */
export const PatternClause3 = Schema.Tuple([IdentityTerm, IdentityTerm, Term]);
export const PatternClause4 = Schema.Tuple([IdentityTerm, IdentityTerm, Term, IdentityTerm]);
export const PatternClause = Schema.Union([PatternClause4, PatternClause3]).annotate({
  identifier: "PatternClause",
  description: "A pattern clause [entity, attribute, value, tx?] for matching triples",
});

/**
 * Predicate clause: [operator, left, right]
 * Used for filtering based on comparisons
 *
 * Examples:
 * - [">=", "?age", 18]
 * - ["!=", "?status", "inactive"]
 */
export const PredicateClause = Schema.Tuple([PredicateOp, Term, Term]).annotate({
  identifier: "PredicateClause",
  description: "A predicate clause [op, left, right] for filtering",
});

/**
 * Inner clause within a `not` — patterns and predicates only (no nested not/or/link).
 */
const NotInnerClause = Schema.Union([PredicateClause, PatternClause]).annotate({
  identifier: "NotInnerClause",
  description: "A pattern or predicate clause inside a not",
});

/**
 * Not clause: ["not", clause1] or ["not", clause1, clause2, ...]
 * Used for negation - excludes results that match the clause(s).
 *
 * Single pattern: ["not", ["?person", ":banned", true]]
 *   — excludes results where the pattern matches.
 *
 * Conjunctive negation: ["not", ["?task", ":task/employee", "?emp"], ["?task", ":task/type", "I-9"]]
 *   — excludes results where ALL clauses match simultaneously (like NOT EXISTS with a JOIN).
 *   — inner clauses can be patterns or predicates.
 */
export const NotClause = Schema.Tuple([
  Schema.Literal("not"),
  NotInnerClause,
  Schema.optional(NotInnerClause),
  Schema.optional(NotInnerClause),
  Schema.optional(NotInnerClause),
  Schema.optional(NotInnerClause),
  Schema.optional(NotInnerClause),
  Schema.optional(NotInnerClause),
  Schema.optional(NotInnerClause),
]).annotate({
  identifier: "NotClause",
  description: 'A negation clause ["not", clause, ...] to exclude matching results',
});

/**
 * Alternative within an `or` — patterns, predicates, and negation only.
 * `or` alternatives are filter/existence checks and do not bind variables outward.
 */
export const OrAlternative = Schema.Union([PredicateClause, NotClause, PatternClause]).annotate({
  identifier: "OrAlternative",
  description: "A pattern, predicate, or not clause inside an or",
});

/**
 * Or clause: ["or", [alternative1, alternative2, ...]]
 * Used for disjunction - matches if any alternative matches.
 *
 * Examples:
 * - ["or", [["?person", ":name", "Alice"], ["?person", ":name", "Bob"]]]
 * - ["or", [["=", "?status", "offline"], ["not", ["?step", ":output", "?out"]]]]
 */
export const OrClause = Schema.Tuple([Schema.Literal("or"), Schema.Array(OrAlternative)]).annotate({
  identifier: "OrClause",
  description: 'A disjunction clause ["or", [alternative1, alternative2, ...]]',
});

// =============================================================================
// Rule Application (for recursive queries)
// =============================================================================

/**
 * Rule application clause: [ruleName, arg1, arg2]
 * Used to apply a recursive rule in the where clause
 *
 * The rule name must not start with ? or : to distinguish from patterns
 *
 * Examples:
 * - ["ancestor", "alice", "?ancestor"]
 * - ["connected", "?a", "?b"]
 */
export const RuleApplication = Schema.Tuple([
  Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_-]*$/)),
    Schema.annotate({ description: "Rule name (alphanumeric, no ? or : prefix)" }),
  ),
  IdentityTerm,
  IdentityTerm,
]).annotate({
  identifier: "RuleApplication",
  description:
    "A rule application [ruleName, arg1, arg2] over string identities for recursive queries",
});

/**
 * Clause: pattern, predicate, not, or, or rule application.
 *
 * We distinguish by checking the first element:
 * - If it's an operator (>, >=, <, <=, =, !=), it's a predicate
 * - If it's "not", it's a negation
 * - If it's "or", it's a disjunction
 * - If it's a plain identifier (no ? or :), it's a rule application
 * - Otherwise, it's a pattern
 */
export const Clause = Schema.Union([
  PredicateClause,
  NotClause,
  OrClause,
  RuleApplication,
  PatternClause,
]).annotate({
  identifier: "Clause",
  description: "A clause that is a pattern, predicate, not, or, or rule application",
});

// =============================================================================
// Rules (for recursive queries)
// =============================================================================

/**
 * Rule body clause: can be a pattern or a rule application
 */
export const RuleBodyClause = Schema.Union([PatternClause, RuleApplication]).annotate({
  identifier: "RuleBodyClause",
  description: "A clause in a rule body: pattern or rule application",
});

/**
 * Rule definition for recursive queries
 *
 * A rule defines a derived relationship. Multiple rules with the same name
 * are combined with UNION (like OR).
 *
 * Example - Ancestor rule (two definitions):
 * ```typescript
 * // Base case: direct parent
 * { name: "ancestor", body: [["?x", ":parent", "?y"]] }
 *
 * // Recursive case: parent of ancestor
 * { name: "ancestor", body: [["?x", ":parent", "?z"], ["ancestor", "?z", "?y"]] }
 * ```
 */
export const Rule = Schema.Struct({
  /** Name of the rule (used in rule applications) */
  name: Schema.String.pipe(
    Schema.check(
      Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_-]*$/),
      Schema.makeFilter((name: string) => name !== "not" && name !== "or", {
        expected: "a non-reserved rule name",
      }),
    ),
    Schema.annotate({ description: "Rule name" }),
  ),
  /** Body clauses that define when this rule matches */
  body: Schema.Array(RuleBodyClause),
  /** Maximum recursion depth (defaults to 100) */
  maxDepth: Schema.optional(
    Schema.Int.pipe(
      Schema.check(Schema.isGreaterThanOrEqualTo(1)),
      Schema.annotate({ description: "Positive safe-integer recursion depth" }),
    ),
  ),
}).annotate({
  identifier: "Rule",
  description: "A rule definition for recursive queries",
});

// =============================================================================
// Aggregation
// =============================================================================

/**
 * Aggregate operator
 */
export const AggregateOp = Schema.Literals(["count", "sum", "avg", "min", "max"]).annotate({
  identifier: "AggregateOp",
  description: "Aggregation operator: count, sum, avg, min, max",
});

/**
 * Aggregate specification: [operator, sourceVariable, targetVariable]
 *
 * Examples:
 * - ["count", "?person", "?count"]
 */
export const AggregateSpec = Schema.Tuple([AggregateOp, Variable, Variable]).annotate({
  identifier: "AggregateSpec",
  description: 'An aggregation [op, source, target] like ["count", "?person", "?count"]',
});

// =============================================================================
// Query Modifiers
// =============================================================================

/**
 * Order direction for sorting results
 */
export const OrderDirection = Schema.Literals(["asc", "desc"]).annotate({
  identifier: "OrderDirection",
  description: "Sort direction: ascending or descending",
});

/**
 * Order by specification: { variable, direction? }
 * Used for sorting query results
 *
 * Examples:
 * - { variable: "?name" } - sort by name ascending (default)
 * - { variable: "?age", direction: "desc" } - sort by age descending
 */
export const OrderBySpec = Schema.Struct({
  variable: Variable,
  direction: Schema.optional(OrderDirection),
}).annotate({
  identifier: "OrderBySpec",
  description: "Sorting specification for query results",
});

/**
 * Having clause: [operator, left, right]
 * Used for filtering aggregated results (like SQL HAVING)
 *
 * Examples:
 * - [">=", "?count", 5] - only include groups where count >= 5
 */
export const HavingClause = Schema.Tuple([PredicateOp, Term, Term]).annotate({
  identifier: "HavingClause",
  description: "A having clause for filtering aggregated results",
});

// =============================================================================
// Query Structure
// =============================================================================

/**
 * DatalogQuery: the main query structure
 *
 * - find: array of terms to return (variables will be resolved)
 * - where: array of clauses to match/filter
 * - aggregate: optional array of aggregation specs
 *
 * Example:
 * ```typescript
 * {
 *   find: ["?name", "?age"],
 *   where: [
 *     ["?person", ":name", "?name"],
 *     ["?person", ":age", "?age"],
 *     [">=", "?age", 18]
 *   ]
 * }
 * ```
 *
 * With aggregation:
 * ```typescript
 * {
 *   find: ["?dept", "?count"],
 *   where: [
 *     ["?person", ":department", "?dept"]
 *   ],
 *   aggregate: [
 *     ["count", "?person", "?count"]
 *   ]
 * }
 * ```
 */
export const DatalogQuery = Schema.Struct({
  find: Schema.Array(Term),
  where: Schema.Array(Clause),
  aggregate: Schema.optional(Schema.Array(AggregateSpec)),
  having: Schema.optional(Schema.Array(HavingClause)),
  orderBy: Schema.optional(Schema.Array(OrderBySpec)),
  limit: Schema.optional(
    Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0))),
  ),
  offset: Schema.optional(
    Schema.Number.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    ),
  ),
  /**
   * Recursive rule definitions applied by rule-application clauses in `where`.
   * SQL backends compile these to recursive CTEs; KV backends evaluate them
   * with fixpoint evaluation.
   */
  rules: Schema.optional(Schema.Array(Rule)),
  optionalProjection: Schema.optional(
    Schema.Struct({
      rowBinding: Variable,
      fields: Schema.Array(
        Schema.Struct({
          attribute: DatalogAttribute,
          variable: Variable,
        }),
      ),
    }),
  ),
}).annotate({
  identifier: "DatalogQuery",
  description: "A Datalog query with find, where, and optional modifiers",
});

// =============================================================================
// Wrapped Query (Subquery Filtering & Pagination)
// =============================================================================

/**
 * Filter operators for wrapper filtering
 * Supports text matching (LIKE), equality, and comparison
 */
export const WrapperFilterOp = Schema.Literals([
  "=",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "like",
  "not-like",
  "ilike",
  "not-ilike",
  "is-null",
  "is-not-null",
]).annotate({
  identifier: "WrapperFilterOp",
  description: "Filter operator for wrapper queries",
});

/**
 * A filter condition applied to wrapper query results
 *
 * Examples:
 * - { column: "?name", op: "like", value: "%Smith%" }
 * - { column: "?age", op: ">=", value: 18 }
 * - { column: "?status", op: "is-null" }
 */
export const WrapperFilter = Schema.Struct({
  /** Column to filter (variable name from inner query's find clause) */
  column: Variable,
  /** Filter operator */
  op: WrapperFilterOp,
  /** Filter value (not required for is-null/is-not-null) */
  value: Schema.optional(Constant),
}).annotate({
  identifier: "WrapperFilter",
  description: "A filter condition applied to wrapper query results",
});

/**
 * Wrapped query specification for subquery semantics
 *
 * Execution order:
 * 1. Inner query runs with its own limit/offset
 * 2. Wrapper filters are applied to inner results
 * 3. Wrapper orderBy/limit/cursor paginate the filtered results
 * 4. If includeCount=true, total filtered count is also returned
 *
 * Example with cursor pagination:
 * ```typescript
 * {
 *   inner: {
 *     find: ["?name", "?age"],
 *     where: [["?p", ":name", "?name"], ["?p", ":age", "?age"]],
 *     limit: 1000
 *   },
 *   orderBy: [{ variable: "?name", direction: "asc" }],
 *   filters: [{ column: "?name", op: "ilike", value: "%smith%" }],
 *   limit: 20,
 *   cursor: firstPage.nextCursor, // Opaque cursor returned by queryPage
 *   includeCount: true
 * }
 * ```
 */
export const WrappedQuery = Schema.Struct({
  /** The inner Datalog query (may have its own limit/offset) */
  inner: DatalogQuery,
  /** Additional filters on the inner query's result columns */
  filters: Schema.optional(Schema.Array(WrapperFilter)),
  /** Optional wrapper order; the service completes it with projected-row tie-breakers */
  orderBy: Schema.optional(Schema.Array(OrderBySpec)),
  /** Public page size: defaults to 100; maximum 1,000 (the executor receives one lookahead row) */
  limit: Schema.optional(
    Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0))),
  ),
  /** Opaque, versioned keyset cursor returned by `Triples.queryPage` */
  cursor: Schema.optional(Schema.String),
  /** Opt into an additional complete count of filtered results; defaults to false */
  includeCount: Schema.optional(Schema.Boolean),
}).annotate({
  identifier: "WrappedQuery",
  description: "A wrapped query with subquery semantics for filtering and cursor-based pagination",
});

/**
 * Response from a wrapped query execution
 */
export const WrappedQueryResponse = Schema.Struct({
  /** Query results as array of records */
  results: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  /** Total count of filtered results (if includeCount was true) */
  totalCount: Schema.optional(Schema.Number),
  /** Cursor for the next page (if more results available) */
  nextCursor: Schema.optional(Schema.String),
  /** Authorization decision identifier for auditing and trace correlation */
  decisionId: Schema.optional(Schema.String),
}).annotate({
  identifier: "WrappedQueryResponse",
  description: "Response from a wrapped query with pagination info",
});

// =============================================================================
// Type Exports
// =============================================================================

export type Variable = typeof Variable.Type;
export type DatalogAttribute = typeof DatalogAttribute.Type;
export type Constant = typeof Constant.Type;
export type Term = typeof Term.Type;
export type PredicateOp = typeof PredicateOp.Type;
export type PatternClause3 = typeof PatternClause3.Type;
export type PatternClause4 = typeof PatternClause4.Type;
export type PatternClause = typeof PatternClause.Type;
export type PredicateClause = typeof PredicateClause.Type;
export type NotClause = typeof NotClause.Type;
export type OrAlternative = typeof OrAlternative.Type;
export type OrClause = typeof OrClause.Type;
export type RuleApplication = typeof RuleApplication.Type;
export type RuleBodyClause = typeof RuleBodyClause.Type;
export type Rule = typeof Rule.Type;
export type Clause = typeof Clause.Type;
export type AggregateOp = typeof AggregateOp.Type;
export type AggregateSpec = typeof AggregateSpec.Type;
export type OrderDirection = typeof OrderDirection.Type;
export type OrderBySpec = typeof OrderBySpec.Type;
export type HavingClause = typeof HavingClause.Type;
export type DatalogQuery = typeof DatalogQuery.Type;
export type WrapperFilterOp = typeof WrapperFilterOp.Type;
export type WrapperFilter = typeof WrapperFilter.Type;
export type WrappedQuery = typeof WrappedQuery.Type;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if a term is a variable (starts with ?)
 */
export const isVariable = (term: unknown): term is string =>
  typeof term === "string" && term.startsWith("?");

/**
 * Check if a term is an attribute (starts with :)
 */
export const isAttribute = (term: unknown): term is string =>
  typeof term === "string" && term.startsWith(":");

/**
 * Check if a clause is a predicate clause (first element is an operator)
 */
export const isPredicateClause = (clause: Clause): clause is PredicateClause => {
  const ops = [">", ">=", "<", "<=", "=", "!="];
  return Array.isArray(clause) && ops.includes(clause[0] as string);
};

/**
 * Check if a clause is a not clause (first element is "not")
 */
export const isNotClause = (clause: Clause): clause is NotClause => {
  return Array.isArray(clause) && clause[0] === "not";
};

/**
 * Check if a clause is an or clause (first element is "or")
 */
export const isOrClause = (clause: Clause): clause is OrClause => {
  return Array.isArray(clause) && clause[0] === "or";
};

export const normalizeOrAlternatives = (
  orClause: OrClause | readonly ["or", ...Clause[]],
): OrAlternative[] => {
  if (!Array.isArray(orClause) || orClause[0] !== "or") {
    throw new Error(`Invalid or clause: ${JSON.stringify(orClause)}`);
  }

  const assertAlternative = (clause: unknown): OrAlternative => {
    const candidate = clause as Clause;
    if (isOrClause(candidate)) {
      throw new Error(`Nested or alternatives are not supported: ${JSON.stringify(clause)}`);
    }
    if (!isPredicateClause(candidate) && !isNotClause(candidate) && !isPatternClause(candidate)) {
      throw new Error(`Invalid or alternative: ${JSON.stringify(clause)}`);
    }
    return candidate as OrAlternative;
  };

  if (orClause.length === 2 && Array.isArray(orClause[1])) {
    return (orClause[1] as readonly unknown[]).map(assertAlternative);
  }

  if (orClause.length > 2) {
    return (orClause as readonly unknown[]).slice(1).map(assertAlternative);
  }

  throw new Error(`Invalid or clause arity: ${JSON.stringify(orClause)}`);
};

/**
 * Check if a clause is a rule application (first element is alphanumeric, no ? or :,
 * and second element is NOT an attribute - this distinguishes from patterns)
 *
 * Pattern: ["p1", ":name", "Alice"] - second element is attribute (:name)
 * Rule:    ["ancestor", "alice", "?x"] - second element is term (alice), not attribute
 */
export const isRuleApplication = (clause: Clause): clause is RuleApplication => {
  if (!Array.isArray(clause) || clause.length !== 3) return false;
  const first = clause[0];
  const second = clause[1];

  // First element must be a valid rule name (alphanumeric identifier)
  // Must match the pattern: /^[a-zA-Z_][a-zA-Z0-9_-]*$/
  const isRuleName =
    typeof first === "string" &&
    /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(first) &&
    !["not", "or"].includes(first);

  if (!isRuleName) return false;

  // Second element must NOT be an attribute (if it's an attribute, it's a pattern)
  // This distinguishes ["p1", ":name", "Alice"] (pattern) from ["ancestor", "alice", "?x"] (rule)
  const secondIsAttribute = typeof second === "string" && second.startsWith(":");

  return !secondIsAttribute;
};

/**
 * Check if a clause is a pattern clause (not a predicate, not, or, or rule application)
 * Accepts both 3-tuple and 4-tuple patterns
 */
export const isPatternClause = (clause: Clause): clause is PatternClause => {
  if (!Array.isArray(clause)) return false;
  // Accept 3 or 4 elements for pattern clauses
  if (clause.length < 3 || clause.length > 4) return false;
  return (
    !isPredicateClause(clause) &&
    !isNotClause(clause) &&
    !isOrClause(clause) &&
    !isRuleApplication(clause)
  );
};

/**
 * Check if a pattern clause is a 4-tuple (includes transaction binding)
 */
export const isPattern4Tuple = (pattern: PatternClause): pattern is PatternClause4 => {
  return pattern.length === 4;
};

// =============================================================================
// API Request/Response Schemas
// =============================================================================

/**
 * Query compilation and execution metrics
 */
export const QueryMetrics = Schema.Struct({
  // SQL Complexity
  joinCount: Schema.Number,
  whereConditionCount: Schema.Number,
  subqueryCount: Schema.Number,
  cteCount: Schema.Number,
  sqlLength: Schema.Number,
  paramCount: Schema.Number,

  // Clause Breakdown
  patternCount: Schema.Number,
  predicateCount: Schema.Number,
  notClauseCount: Schema.Number,
  orClauseCount: Schema.Number,

  // Features Used
  hasAggregation: Schema.Boolean,
  isRecursive: Schema.Boolean,
  aggregateOps: Schema.Array(Schema.String),

  // Timing
  compilationTimeMs: Schema.Number,
});
export type QueryMetrics = typeof QueryMetrics.Type;

/**
 * A single step in a query plan.
 * For SQL backends, this is a SQL statement.
 * For DynamoDB, this might be a JSON-serialized scan/query operation.
 * For any backend, it's an opaque string representation of what will execute.
 */
export const QueryPlanStep = Schema.Struct({
  /** Human-readable label for this step (e.g., "main", "count", "CTE: ancestor") */
  label: Schema.String,
  /** The query string in the backend's native format (SQL, JSON, etc.) */
  query: Schema.String,
  /** Parameters/bindings for the query */
  params: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type QueryPlanStep = typeof QueryPlanStep.Type;

/**
 * Backend-agnostic query plan: the compiled queries that would execute.
 */
export const QueryPlan = Schema.Struct({
  /** The backend that generated this plan (e.g., "sqlite", "postgresql", "dynamodb") */
  backend: Schema.String,
  /** Ordered list of query steps that would execute */
  steps: Schema.Array(QueryPlanStep),
});
export type QueryPlan = typeof QueryPlan.Type;

/**
 * Debug information returned with query results when debug mode is enabled
 */
export const QueryDebugInfo = Schema.Struct({
  metrics: QueryMetrics,
  executionTimeMs: Schema.Number,
  resultCount: Schema.Number,
  generatedSql: Schema.String,
  params: Schema.Array(Schema.Unknown),
  queryPlan: Schema.optional(QueryPlan),
});
export type QueryDebugInfo = typeof QueryDebugInfo.Type;

/**
 * Result of explaining a query (compile without execute).
 */
export const ExplainResult = Schema.Struct({
  queryPlan: QueryPlan,
  metrics: Schema.optional(QueryMetrics),
});
export type ExplainResult = typeof ExplainResult.Type;

/**
 * Array of query result bindings (variable name -> value)
 */
export const DatalogQueryResults = Schema.Array(Schema.Record(Schema.String, Schema.Unknown));
export type DatalogQueryResults = typeof DatalogQueryResults.Type;

/**
 * Complete Datalog query response with results and optional debug info
 */
export const DatalogQueryResponse = Schema.Struct({
  results: DatalogQueryResults,
  debug: Schema.optional(QueryDebugInfo),
  /** Authorization decision identifier for auditing and trace correlation */
  decisionId: Schema.optional(Schema.String),
});
export type DatalogQueryResponse = typeof DatalogQueryResponse.Type;

// =============================================================================
// Type Check Response
// =============================================================================

/**
 * A single diagnostic from the type checker.
 */
export const TypeCheckDiagnosticSchema = Schema.Struct({
  severity: Schema.Literals(["error", "warning", "info"]),
  message: Schema.String,
  clauseIndex: Schema.optional(Schema.Number),
  variable: Schema.optional(Schema.String),
  attribute: Schema.optional(Schema.String),
});
export type TypeCheckDiagnosticSchema = typeof TypeCheckDiagnosticSchema.Type;

/**
 * Response from the type-check endpoint.
 *
 * Contains inferred variable types, the computed result type,
 * diagnostics (errors/warnings), and a convenience hasErrors flag.
 */
export const TypeCheckResponse = Schema.Struct({
  /** Inferred types for each query variable (e.g., "?name" → "Str") */
  variableTypes: Schema.Record(Schema.String, Schema.String),
  /** The computed result type as a display string (e.g., "List<{name: Str, age: Num}>") */
  resultType: Schema.String,
  /** All diagnostics from the type checker */
  diagnostics: Schema.Array(TypeCheckDiagnosticSchema),
  /** Whether any error-severity diagnostics exist */
  hasErrors: Schema.Boolean,
});
export type TypeCheckResponse = typeof TypeCheckResponse.Type;
