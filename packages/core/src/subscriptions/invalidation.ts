/**
 * Subscription Invalidation Check
 *
 * Pure function that determines if a subscription's dependencies
 * overlap with a batch of changes, using proven attribute/subject dependencies.
 */

import type { QueryDependencies, TripleChange, InvalidationResult } from "./types.js";

/**
 * Check if a subscription with given dependencies is affected by a batch of changes.
 *
 * This is a conservative check: it may return true when the subscription
 * wouldn't actually change (false positive), but should never return false
 * when the subscription would change (no false negatives).
 *
 * @param deps Dependencies extracted from a subscription's query
 * @param changes Batch of triple changes to check
 * @returns Result indicating if the subscription is affected and why
 */
export function checkInvalidation(
  deps: QueryDependencies,
  changes: readonly TripleChange[],
): InvalidationResult {
  // Fast path: no changes means not affected
  if (changes.length === 0) {
    return {
      affected: false,
      matchingChanges: [],
      reason: "No changes provided",
    };
  }

  if (deps.hasDynamicAttributes) {
    return {
      affected: true,
      matchingChanges: [...changes],
      reason: "Query reads dynamic attributes and cannot be narrowed statically",
    };
  }
  if (deps.attributes.size === 0 && deps.entityTypes.size === 0) {
    return { affected: false, matchingChanges: [], reason: "Query has no data dependencies" };
  }
  const matchingChanges = changes.filter((change) => {
    if (!deps.attributes.has(change.attribute)) return false;
    const subjects = deps.subjectsByAttribute?.get(change.attribute);
    return subjects == null || subjects.has(change.entityId);
  });

  if (matchingChanges.length === 0) {
    return {
      affected: false,
      matchingChanges: [],
      reason: "No changes overlap with query dependencies",
    };
  }

  return {
    affected: true,
    matchingChanges,
    reason: `${matchingChanges.length} change(s) affect attributes read by this query`,
  };
}

/**
 * Check if a single change affects a subscription's dependencies.
 *
 * Convenience wrapper around checkInvalidation for single-change scenarios.
 *
 * @param deps Dependencies extracted from a subscription's query
 * @param change Single triple change to check
 * @returns true if the subscription might be affected
 */
export function isAffectedByChange(deps: QueryDependencies, change: TripleChange): boolean {
  return checkInvalidation(deps, [change]).affected;
}
