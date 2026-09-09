export {
  DuckdbSnapshot,
  makeDuckdbSnapshot,
  type DuckdbSnapshotOptions,
  type DuckdbSnapshotService,
} from "./DuckdbSnapshot.js";
export { DuckdbDialect } from "./dialect.js";
export {
  DuckdbFederation,
  makeDuckdbFederation,
  type DuckdbFederationOptions,
  type DuckdbFederationService,
  type FederationExecution,
  type FederationSourceMetadata,
  type FederatedWrappedQuery,
} from "./DuckdbFederation.js";
export {
  SnapshotProvider,
  sourceEntity,
  decodeSourceEntity,
  databaseEntity,
  DATABASE_ATTRIBUTE,
  TENANT_ATTRIBUTE,
  TX_DATABASE_ATTRIBUTE,
  type LocalDatabase,
  type FederatedQuery,
  type FederatedClause,
  type SourcePattern,
} from "./federation/types.js";
export type { FederationPlan } from "./federation/planner.js";
