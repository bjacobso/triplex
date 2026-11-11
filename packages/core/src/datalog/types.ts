/**
 * Runtime types for Datalog query execution
 */

import type {
  Variable,
  Constant,
  Term,
  PatternClause,
  FactPattern,
  IntervalPattern,
  IntervalBounds,
  PredicateClause,
  NotClause,
  OrAlternative,
  OrClause,
  RuleApplication,
  RuleBodyClause,
  Rule,
  Clause,
  AggregateOp,
  AggregateSpec,
  OrderDirection,
  OrderBySpec,
  HavingClause,
  DatalogQuery,
  WrapperFilterOp,
  WrapperFilter,
  WrappedQuery,
} from "./schema.js";

// Re-export schema types for convenience
export type {
  Variable,
  Constant,
  Term,
  PatternClause,
  FactPattern,
  IntervalPattern,
  IntervalBounds,
  PredicateClause,
  NotClause,
  OrAlternative,
  OrClause,
  RuleApplication,
  RuleBodyClause,
  Rule,
  Clause,
  AggregateOp,
  AggregateSpec,
  OrderDirection,
  OrderBySpec,
  HavingClause,
  DatalogQuery,
  WrapperFilterOp,
  WrapperFilter,
  WrappedQuery,
};

/**
 * Context: a mapping from variable names to their bound values
 *
 * Example:
 * ```typescript
 * { "?person": "p1", "?name": "Alice", "?age": 30 }
 * ```
 */
export interface Context {
  readonly [variable: string]: Constant | null;
}

/**
 * An empty context with no bindings
 */
export const emptyContext: Context = {};

/**
 * Query result: an array of contexts (variable bindings)
 * Each context represents one result row
 */
export type QueryResult = readonly Context[];
