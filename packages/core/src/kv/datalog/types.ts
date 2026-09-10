/**
 * Internal types for the KV Datalog executor.
 *
 * These types bridge between the Datalog schema types
 * and the hexastore storage layer.
 *
 * Type guards are implemented locally to keep the KV engine self-contained.
 */

import type {
  Variable,
  Constant,
  Term,
  PatternClause,
  PredicateClause,
  NotClause,
  OrAlternative,
  OrClause,
  RuleApplication,
  Rule,
  Clause,
  AggregateOp,
  AggregateSpec,
  OrderBySpec,
  HavingClause,
  DatalogQuery,
  WrapperFilter,
  WrappedQuery,
} from "../../datalog/schema.js";

// Re-export domain types used by the executor
export type {
  Variable,
  Constant,
  Term,
  PatternClause,
  PredicateClause,
  NotClause,
  OrAlternative,
  OrClause,
  RuleApplication,
  Rule,
  Clause,
  AggregateOp,
  AggregateSpec,
  OrderBySpec,
  HavingClause,
  DatalogQuery,
  WrapperFilter,
  WrappedQuery,
};

// ─── Context (variable bindings) ───────────────────────────────────────────

/**
 * A Context maps variable names to their bound values.
 * This is the fundamental unit of intermediate results in the executor.
 *
 * Example: { "?person": "emp:alice", "?name": "Alice", "?age": 30 }
 */
export interface Context {
  readonly [variable: string]: Constant | null;
}

/** An empty context with no bindings. */
export const emptyContext: Context = {};

/** An array of contexts representing a relation (like a table of rows). */
export type Relation = readonly Context[];

// ─── Type Guards ───────────────────────────────────────────────────────────
// Local implementations matching the public datalog schema surface to avoid
// runtime import issues. These mirror the logic in @triplex-build/triplex.

/** Check if a term is a variable (string starting with ?) */
export const isVariable = (term: unknown): term is string =>
  typeof term === "string" && term.startsWith("?");

/** Check if a term is an attribute (string starting with :) */
export const isAttribute = (term: unknown): term is string =>
  typeof term === "string" && term.startsWith(":");

const PREDICATE_OPS = [">", ">=", "<", "<=", "=", "!="];

/** Check if a clause is a predicate clause (first element is an operator) */
export const isPredicateClause = (clause: Clause): clause is PredicateClause =>
  Array.isArray(clause) && PREDICATE_OPS.includes(clause[0] as string);

/** Check if a clause is a not clause (first element is "not") */
export const isNotClause = (clause: Clause): clause is NotClause =>
  Array.isArray(clause) && clause[0] === "not";

/** Check if a clause is an or clause (first element is "or") */
export const isOrClause = (clause: Clause): clause is OrClause =>
  Array.isArray(clause) && clause[0] === "or";

/**
 * Check if a clause is a rule application.
 * First element is alphanumeric rule name (not "not"/"or"),
 * second element is NOT an attribute (distinguishes from patterns).
 */
export const isRuleApplication = (clause: Clause): clause is RuleApplication => {
  if (!Array.isArray(clause) || clause.length !== 3) return false;
  const first = clause[0];
  const second = clause[1];

  const isRuleName =
    typeof first === "string" &&
    /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(first) &&
    !["not", "or"].includes(first);

  if (!isRuleName) return false;

  const secondIsAttribute = typeof second === "string" && second.startsWith(":");
  return !secondIsAttribute;
};

/**
 * Check if a clause is a pattern clause (3 or 4 tuple that isn't
 * a predicate, not, or, or rule application).
 */
export const isPatternClause = (clause: Clause): clause is PatternClause => {
  if (!Array.isArray(clause)) return false;
  if (clause.length < 3 || clause.length > 4) return false;
  return (
    !isPredicateClause(clause) &&
    !isNotClause(clause) &&
    !isOrClause(clause) &&
    !isRuleApplication(clause)
  );
};
