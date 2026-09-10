/**
 * Unified database package.
 *
 * Owns the collapsed public database surface.
 * SQL-bound code (layers, migrations, storage backends) lives in @triplex-build/triplex-sql.
 */

export * from "./Branded.js";
export * from "./Triple.js";
export * from "./Temporal.js";
export {
  DEFAULT_QUERY_PAGE_SIZE,
  MAX_QUERY_PAGE_SIZE,
  type PaginationCursor,
} from "./Pagination.js";
export {
  type EntityPageCursor,
  type EntityPageRequest,
  type EntityPageSnapshot,
} from "./EntityPage.js";
export * from "./Value.js";
export * as Constraint from "./Constraint.js";
export * from "./errors/index.js";
export * from "./types/Pattern.js";
export { isVariable as isPatternVariable } from "./types/Pattern.js";
export {
  type Subscription,
  type AffectedSubscriptions,
  TopicFilteredSyncHub,
  SubscriptionManager,
  makeSubscriptionManager,
  SubscriptionManagerLive,
  type SubscriptionManagerService,
  type SyncAttachedQuery,
  type SyncConnection,
  type SyncHubMessageHooks,
} from "./subscriptions/index.js";

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
  OrderBySpec,
  HavingClause,
  DatalogQuery,
  WrapperFilterOp,
  WrapperFilter,
  WrappedQuery,
  RuleApplication,
  Rule,
  isVariable,
  isAttribute,
  isPredicateClause,
  isPatternClause,
  isNotClause,
  isOrClause,
  isRuleApplication,
  isTypedConstant,
  normalizeOrAlternatives,
} from "./datalog/schema.js";

export type { Context, QueryResult } from "./datalog/types.js";
export type { DatalogQueryValidationError } from "./datalog/validation.js";

export {
  Triples,
  type TriplesService,
  type TransactionResult,
  type TransactionMeta,
  type TransactionChange,
  type TransactionRecord,
  type TransactionPageRequest,
  type TransactionPage,
  type EntityTransactionPageRequest,
  type EntityTransactionPage,
  type DependencyState,
  type EntityPage,
  type QueryOptions,
  type PagedQueryOptions,
  type QueryResponse,
  type PagedQueryResponse,
  type ExplainResult,
} from "./store/Triples.js";
export {
  DatabaseManager,
  type DatabaseManagerService,
  type Database,
  type ClearResult,
} from "./store/DatabaseManager.js";

// =============================================================================
// Snapshots
// =============================================================================

export {
  SnapshotService,
  type SnapshotServiceShape,
  SnapshotError,
} from "./snapshots/SnapshotService.js";
export {
  type EntitySnapshot,
  type EntityDiff,
  type SnapshotValue,
  type SnapshotAttributeMap,
} from "./snapshots/canonical.js";
export { KvTriples } from "./kv/layers/KvTriplesLive.js";
