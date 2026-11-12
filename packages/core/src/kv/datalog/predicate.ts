/**
 * Predicate clause evaluation for the KV Datalog executor.
 *
 * Predicates are filter operations: they don't produce new bindings,
 * they just filter existing contexts based on comparison operators.
 */

import { SEALED_BINDING_PREFIX } from "../../Value.js";
import {
  isVariable,
  type Context,
  type Term,
  type Constant,
  type PredicateClause,
} from "./types.js";

// ─── Term resolution ───────────────────────────────────────────────────────

/**
 * Resolve a term to its concrete value in the given context.
 * - Variables are looked up in the context
 * - Constants are returned as-is
 * Returns null if a variable is unbound.
 */
export const resolveTerm = (term: Term | null, context: Context): Constant | null => {
  if (isVariable(term)) {
    return term in context ? context[term]! : null;
  }
  // TypedConstant (ref) — extract the value
  if (typeof term === "object" && term !== null && "type" in term) {
    const typed = term as { type: string; value: string };
    if (typed.type === "ref") return typed.value;
    if (typed.type === "blind") return `${SEALED_BINDING_PREFIX}${typed.value}`;
  }
  return term as Constant;
};

// ─── Predicate evaluation ──────────────────────────────────────────────────

/**
 * Evaluate a predicate clause against a context.
 *
 * A PredicateClause is [op, left, right] where op is one of:
 * ">", ">=", "<", "<=", "=", "!="
 *
 * Returns true if the predicate is satisfied, false otherwise.
 * Unbound variables or type mismatches result in false (no match).
 */
export const evaluatePredicate = (predicate: PredicateClause, context: Context): boolean => {
  const [op, leftTerm, rightTerm] = predicate;

  const left = resolveTerm(leftTerm, context);
  const right = resolveTerm(rightTerm, context);

  // Unbound variables → predicate fails
  if (
    (isVariable(leftTerm) && !(leftTerm in context)) ||
    (isVariable(rightTerm) && !(rightTerm in context))
  )
    return false;

  // Numeric comparisons require numbers
  if (op === ">" || op === ">=" || op === "<" || op === "<=") {
    if (typeof left !== "number" || typeof right !== "number") return false;
  }

  switch (op) {
    case ">":
      return (left as number) > (right as number);
    case ">=":
      return (left as number) >= (right as number);
    case "<":
      return (left as number) < (right as number);
    case "<=":
      return (left as number) <= (right as number);
    case "=":
      return left === right;
    case "!=":
      return left !== right;
    default:
      return false;
  }
};

/**
 * Filter a set of contexts by a predicate clause.
 * Returns only contexts where the predicate is satisfied.
 */
export const filterByPredicate = (
  predicate: PredicateClause,
  contexts: readonly Context[],
): Context[] => {
  return contexts.filter((ctx) => evaluatePredicate(predicate, ctx));
};
