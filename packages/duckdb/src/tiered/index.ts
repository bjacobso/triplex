export {
  COLD_ERASED_KEYS_TABLE,
  COLD_ERASED_KEYS_TABLE_DDL,
  buildAttachHotSql,
  buildFederatedTransactionEntitiesViewSql,
  buildFederatedTransactionsViewSql,
  buildFederatedTriplesViewSql,
  buildFederatedViewsDdl,
  extractColdDatasetPaths,
  recordColdErasedKeys,
  setupFederatedViews,
  syncHotTablesToDuckDb,
  type ColdDatasetPaths,
  type FederatedViewsConfig,
  type HotTierSource,
} from "./FederatedViews.js";

export {
  decideTierRoute,
  inspectDatalogQueryForRouting,
  makeTieredQueryExecutor,
  makeTieredQueryExecutorLayer,
  type QueryRoutingInspection,
  type TierRouteInput,
  type TierRoutingDecision,
  type TierRoutingPolicy,
  type TierRoutingReason,
  type TierTarget,
  type TieredQueryExecutorOptions,
} from "./TieredQueryExecutor.js";

export { TieredTriples, makeTieredTriples, type TieredTriplesOptions } from "./TieredTriples.js";
