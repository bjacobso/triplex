/**
 * Datalog Query Engine
 *
 * A JSON-based Datalog query engine for the Triple Store.
 * Compiles queries directly to SQL for efficient execution.
 *
 * @example
 * ```typescript
 * import { Triples } from "@triplex-build/triplex"
 *
 * const result = yield* Triples.query({
 *   find: ["?name", "?age"],
 *   where: [
 *     ["?person", ":name", "?name"],
 *     ["?person", ":age", "?age"],
 *     [">=", "?age", 18]
 *   ]
 * })
 * ```
 *
 * @module
 */

// Schema and validation
export {
  Variable,
  DatalogAttribute,
  Constant,
  Term,
  PredicateOp,
  PatternClause,
  PredicateClause,
  NotClause,
  OrAlternative,
  OrClause,
  Clause,
  AggregateOp,
  AggregateSpec,
  DatalogQuery,
  WrapperFilterOp,
  WrapperFilter,
  WrappedQuery,
  isVariable,
  isAttribute,
  isPredicateClause,
  isPatternClause,
  isNotClause,
  isOrClause,
  normalizeOrAlternatives,
} from "./schema.js";

// Types
export type { Context, QueryResult } from "./types.js";

// SQL Compiler
export {
  compile,
  compileToSql,
  compileWithRules,
  compileWithRulesToSql,
  type CompiledQuery,
  type QueryMetrics,
} from "./compiler.js";

// Wrapper Compiler (CTE-based subquery pagination)
export { compileWrapped, type CompiledWrappedQuery } from "./wrapper.js";

export {
  validateDatalogQuery,
  validateWrappedQuery,
  type DatalogQueryValidationError,
} from "./validation.js";

// NOTE: QueryPlan translation (toDatalogQuery) and type checker (typeCheckDatalogQuery)
// live in the compiler layer — they depend on compiler/lisp infrastructure.
