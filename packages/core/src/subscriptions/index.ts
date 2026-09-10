/**
 * Subscription Manager Module
 *
 * Provides primitives for tracking subscriptions and determining
 * which subscriptions need to refresh when data changes.
 *
 * @example
 * ```typescript
 * import {
 *   extractDependencies,
 *   checkInvalidation,
 *   SubscriptionManager,
 *   makeSubscriptionManager,
 * } from "@triplex-build/triplex/subscriptions";
 *
 * // Extract dependencies from a query
 * const deps = extractDependencies({
 *   find: ["?name"],
 *   where: [["?emp", ":employee/name", "?name"]]
 * });
 *
 * // Check if changes affect the query
 * const result = checkInvalidation(deps, [
 *   { entityId: "emp:alice", attribute: ":employee/name", operation: "assert" }
 * ]);
 *
 * // Or use the SubscriptionManager service
 * const manager = yield* makeSubscriptionManager;
 * yield* manager.register("sub1", query);
 * const { affected } = yield* manager.checkAffected(changes);
 * ```
 */

// Types
export type {
  QueryDependencies,
  TripleChange,
  ChangeEvent,
  InvalidationResult,
  Subscription,
  AffectedSubscriptions,
  SyncClientMessage,
  SyncServerMessage,
  SyncSubscribeMessage,
  SyncUnsubscribeMessage,
  SyncConnectedMessage,
  SyncChangesMessage,
  SyncSubscribedMessage,
  SyncErrorMessage,
  SyncPongMessage,
} from "./types.js";

// Dependency extraction
export { extractDependencies, extractEntityType } from "./extract-dependencies.js";

// Invalidation check
export { checkInvalidation, isAffectedByChange } from "./invalidation.js";

// Query hashing
export { hashQuery } from "./query-hash.js";

// Topic tree
export { TopicTree } from "./TopicTree.js";
export {
  TopicFilteredSyncHub,
  type SyncAttachedQuery,
  type SyncConnection,
  type SyncHubMessageHooks,
} from "./SyncHub.js";

// Service
export {
  SubscriptionManager,
  makeSubscriptionManager,
  SubscriptionManagerLive,
  type SubscriptionManagerService,
} from "./SubscriptionManager.js";
