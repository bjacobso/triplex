import {
  isFactPattern,
  isNotClause,
  isOrClause,
  isPredicateClause,
  normalizeOrAlternatives,
  type Clause,
  type DatalogQuery,
} from "../../datalog/schema.js";
import { planIntervalPattern } from "../../datalog/interval.js";
import { patternToScanPattern } from "./pattern.js";
import { patternToScan } from "../hexastore/scan.js";

/** Rule-based access paths. Bound join contexts can further narrow prefix scans at runtime. */
export const explainAccessPaths = (query: DatalogQuery): string => {
  const scans: unknown[] = [];
  const hex = (bytes: Uint8Array) =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const visit = (clauses: readonly Clause[]): void => {
    const predicates = clauses.filter(isPredicateClause);
    for (const clause of clauses) {
      if (isFactPattern(clause)) {
        const normalized = planIntervalPattern(clause, predicates);
        const scan = patternToScanPattern(normalized, {});
        const { choice, start, end } = patternToScan(scan);
        scans.push({
          index: normalized.intervalRange
            ? `attribute-valid-${normalized.intervalRange.bound}`
            : choice.index,
          start: hex(start),
          end: hex(end),
          residual: [
            "recorded visibility",
            ...(query.validTime === "all" ? [] : ["point visibility except :_tx/*"]),
            "pattern equality and interval bounds",
          ],
          ...(normalized.intervalRange
            ? {
                range: normalized.intervalRange,
                initialization: "complete history index backfill before use",
              }
            : {}),
        });
      } else if (isNotClause(clause)) visit(clause.slice(1) as Clause[]);
      else if (isOrClause(clause))
        for (const alternative of normalizeOrAlternatives(clause)) visit([alternative]);
    }
  };
  visit(query.where);
  for (const rule of query.rules ?? []) visit(rule.body);
  return JSON.stringify({ validTime: query.validTime ?? "point", scans }, null, 2);
};
