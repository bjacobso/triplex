/** Public adapter contracts. SQL compilers and hexastore encodings remain private. */
export { Runtime, type RuntimeDefinition, type RuntimeOptions } from "./Runtime.js";
export { DatabaseScope, type DatabaseIdentity } from "./DatabaseScope.js";
export {
  Capabilities,
  entitySnapshots,
  changeEmission,
  type CapabilitySet,
} from "./Capabilities.js";
export { StorageAdapter, type StorageAdapterService } from "../storage/StorageAdapter.js";
export {
  QueryExecutor,
  type QueryExecutorService,
  type QueryContext,
  type QueryPlan,
  type QueryMetrics,
  type QueryDebugInfo,
  type WrappedQueryResult,
} from "../storage/QueryExecutor.js";
export { type TripleRow, type TripleInput, type QueryPattern } from "../storage/types.js";
export {
  KvBackend,
  type KvBackendService,
  type KvTransaction,
  type KvEntry,
  type RangeOptions,
} from "../kv/kv/KvBackend.js";
export { TripleStoreRuntime, type TripleStoreRuntimeService } from "../store/TripleStoreRuntime.js";
export { type StoreCapability, CapabilityError } from "../store/StoreCapability.js";
export {
  ChangeEmitter,
  type ChangeEmitterService,
  type ChangeEvent,
  type TripleChange,
  NoopChangeEmitter,
  NoopChangeEmitterLive,
} from "../store/ChangeEmitter.js";
export {
  SnapshotService,
  SnapshotWriter,
  SnapshotError,
  type SnapshotServiceShape,
  type SnapshotWriterShape,
} from "../snapshots/SnapshotService.js";
export { type EntitySnapshot, type EntityDiff } from "../snapshots/canonical.js";
export { assertDatalogQuery, assertWrappedQuery } from "../datalog/validation.js";
export * from "../errors/index.js";
