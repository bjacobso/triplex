import {
  isVariable,
  normalizePattern,
  type FactPattern,
  type PredicateClause,
  type PatternClause,
} from "./schema.js";
import type { IntervalRange } from "../kv/hexastore/indexes.js";

/** Fixed rule: constant attribute plus a numeric bound equality/range uses its history index. */
export const planIntervalPattern = (
  input: FactPattern,
  predicates: readonly PredicateClause[],
): PatternClause => {
  const pattern = normalizePattern(input);
  if (isVariable(pattern[1])) return pattern;
  for (const bound of ["to", "from"] as const) {
    const term = pattern.valid?.[bound];
    if (term === undefined || term === null) continue;
    let lower: IntervalRange["lower"], upper: IntervalRange["upper"];
    const add = (op: string, value: number) => {
      if (op === "=" || op === ">" || op === ">=") {
        const inclusive = op !== ">";
        if (lower === undefined || value > lower.value || (value === lower.value && !inclusive))
          lower = { value, inclusive };
      }
      if (op === "=" || op === "<" || op === "<=") {
        const inclusive = op !== "<";
        if (upper === undefined || value < upper.value || (value === upper.value && !inclusive))
          upper = { value, inclusive };
      }
    };
    if (typeof term === "number") add("=", term);
    else
      for (const [op, left, right] of predicates) {
        if (left === term && typeof right === "number") add(op, right);
        else if (right === term && typeof left === "number")
          add(
            ({ ">": "<", ">=": "<=", "<": ">", "<=": ">=" } as Record<string, string>)[op] ?? op,
            left,
          );
      }
    if (lower || upper)
      return Object.assign([...pattern] as unknown as PatternClause, {
        valid: pattern.valid,
        intervalRange: { bound, ...(lower ? { lower } : {}), ...(upper ? { upper } : {}) },
      });
  }
  return pattern;
};
