import { Effect } from "effect";
import { UnknownAttributeError } from "../errors/index.js";
import {
  isNotClause,
  isOrClause,
  isFactPattern,
  normalizePattern,
  isIntervalPattern,
  isVariable,
  normalizeOrAlternatives,
} from "./schema.js";
import type { Clause, DatalogQuery, WrappedQuery } from "./types.js";

interface AttributePosition {
  readonly key: string;
  readonly path: string;
}

const positionsOf = (query: DatalogQuery | WrappedQuery): readonly AttributePosition[] => {
  if ("inner" in query)
    return positionsOf(query.inner).map(({ key, path }) => ({ key, path: `inner.${path}` }));
  const positions: AttributePosition[] = [];
  const visit = (clause: Clause, path: string): void => {
    if (isNotClause(clause)) {
      clause.slice(1).forEach((inner, index) => visit(inner as Clause, `${path}[${index + 1}]`));
    } else if (isOrClause(clause)) {
      normalizeOrAlternatives(clause).forEach((alternative, index) =>
        visit(alternative, `${path} alternative ${index}`),
      );
    } else if (isFactPattern(clause)) {
      const pattern = normalizePattern(clause);
      if (!isVariable(pattern[1]))
        positions.push({
          key: pattern[1],
          path: `${path}${isIntervalPattern(clause) ? ".pattern" : ""}[1]`,
        });
    }
  };
  query.where.forEach((clause, index) => visit(clause, `where[${index}]`));
  query.rules?.forEach((rule, index) =>
    rule.body.forEach((clause, bodyIndex) => visit(clause, `rules[${index}].body[${bodyIndex}]`)),
  );
  return positions;
};

/** Collect constant attribute keys, including rules and nested clauses. Does not execute or validate the query. */
export const attributesOf = (query: DatalogQuery | WrappedQuery): ReadonlySet<string> =>
  new Set(positionsOf(query).map(({ key }) => key));

const editDistance = (left: string, right: string): number => {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
};

/** Check constant attributes against a release. Reserved operational keys are always legal. */
export const checkAttributes = (
  query: DatalogQuery | WrappedQuery,
  known: ReadonlySet<string>,
): Effect.Effect<void, UnknownAttributeError> =>
  Effect.suspend(() => {
    for (const { key, path } of positionsOf(query)) {
      if (known.has(key) || key.startsWith(":triplex/") || key.startsWith(":_tx/")) continue;
      let suggestion: string | undefined;
      let closest = Math.min(3, Math.floor(key.length / 4)) + 1;
      for (const candidate of [...known].sort()) {
        const distance = editDistance(key, candidate);
        if (distance < closest) {
          closest = distance;
          suggestion = candidate;
        }
      }
      return Effect.fail(
        new UnknownAttributeError({
          key,
          path,
          ...(suggestion === undefined ? {} : { suggestion }),
          message: `Unknown attribute "${key}" at ${path}${suggestion === undefined ? "." : `; did you mean "${suggestion}"?`} Attributes must be defined in the bound release.`,
        }),
      );
    }
    return Effect.void;
  });
