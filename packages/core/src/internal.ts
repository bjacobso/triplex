/**
 * Backend implementation surface.
 *
 * This entrypoint supports Triplex's legacy adapter implementations. New adapter
 * authors should use `runtime`; applications should use the public database,
 * query, configuration, content, derivation, and operational exports.
 * Internal exports may change between pre-1.0 releases.
 */

export * from "./index.js";

export {
  StorageAdapter,
  type StorageAdapterService,
  type SqlStorageAdapterService,
} from "./storage/StorageAdapter.js";
export { type QueryPattern, type TransactionInfo } from "./storage/types.js";
export {
  QueryExecutor,
  type QueryExecutorService,
  type QueryContext,
  type QueryPlan,
  type QueryDebugInfo,
  type WrappedQueryResult,
  type QueryMetrics as QueryExecutorMetrics,
} from "./storage/QueryExecutor.js";
export { generateId, generateTransactionId, TxAttributes, SystemPrefixes } from "./utils/id.js";

export { TriplesLive } from "./store/TriplesLive.js";
export {
  DatabaseRegistry,
  type DatabaseRegistryService,
  type DatabaseAccessEntry,
} from "./store/DatabaseRegistry.js";
export {
  ChangeEmitter,
  type ChangeEmitterService,
  type ChangeEvent,
  type TripleChange,
  NoopChangeEmitter,
  NoopChangeEmitterLive,
} from "./store/ChangeEmitter.js";
export {
  CapabilityError,
  type StoreCapability,
  validateDependencies,
  composeStore,
  describeCapabilities,
} from "./store/StoreCapability.js";
export { makeWriteInterceptors, type WriteEventCallback } from "./store/writeEventUtils.js";
export { makeChangeEmissionCapability } from "./store/ChangeEmissionCapability.js";
export {
  RuntimeClock,
  type RuntimeClockService,
  RuntimeClockLive,
  DeterministicRuntimeClockLive,
  IdGenerator,
  type IdGeneratorService,
  IdGeneratorLive,
  DeterministicIdGeneratorLive,
  RuntimeServicesLive,
  DeterministicRuntimeServicesLive,
  type DeterministicRuntimeOptions,
} from "./store/RuntimeServices.js";
export {
  TripleStoreRuntime,
  type TripleStoreRuntimeService,
  TripleStoreRuntimeLive,
  TripleStoreRuntimeFromServicesLive,
  TripleStoreRuntimeLayer,
  makeTripleStoreRuntimeLayer,
  getTripleStoreRuntime,
  DeterministicTripleStoreRuntimeLive,
  type DeterministicTripleStoreRuntimeOptions,
} from "./store/TripleStoreRuntime.js";
export { SnapshotWriter, type SnapshotWriterShape } from "./snapshots/SnapshotService.js";
export { SnapshotServiceLive, SnapshotWriterLive } from "./snapshots/SnapshotServiceLive.js";
export { makeEntitySnapshotsCapability } from "./snapshots/EntitySnapshotsCapability.js";
export {
  canonicalize,
  hashCanonical,
  triplesToAttributeMap,
  tripleValueToSnapshotValue,
  EMPTY_ENTITY_HASH,
  diffAttributes,
} from "./snapshots/canonical.js";
export {
  compile,
  compileToSql,
  compileWithRules,
  compileWithRulesToSql,
  type CompiledQuery,
  type QueryMetrics,
} from "./datalog/compiler.js";
export { compileWrapped, type CompiledWrappedQuery } from "./datalog/wrapper.js";
export {
  assertDatalogQuery,
  assertWrappedQuery,
  validateDatalogQuery,
  validateWrappedQuery,
  type DatalogQueryValidationError,
} from "./datalog/validation.js";
export { type SqlDialect, CurrentDialect, SqliteDialect } from "./dialects/index.js";
export { createParamCollector, type ParamCollector } from "./params.js";
export {
  preparePagination,
  finishPagination,
  normalizePaginationOrder,
  type PaginationValue,
  type PreparedPagination,
} from "./Pagination.js";

export {
  KvBackend,
  type KvBackendService,
  type KvEntry,
  type KvTransaction,
  type RangeOptions,
} from "./kv/kv/KvBackend.js";
export { InMemoryKvBackendLive, makeTestKvBackend } from "./kv/kv/InMemoryKvBackend.js";
export { compare, increment, concat, fromHex, toHex, startsWith } from "./kv/kv/encoding.js";
export * from "./kv/hexastore/index.js";
export { type Relation, emptyContext } from "./kv/datalog/types.js";
export {
  tripleValueToConstant,
  constantToTripleValue,
  bindDatom,
  executePattern,
  patternToScanPattern,
} from "./kv/datalog/pattern.js";
export {
  evaluatePredicate as kvEvaluatePredicate,
  filterByPredicate,
  resolveTerm as kvResolveTerm,
} from "./kv/datalog/predicate.js";
export {
  type QueryResult as KvQueryResult,
  type WrappedQueryResult as KvWrappedQueryResult,
  executeQuery as executeKvQuery,
  executeWrappedQuery as executeKvWrappedQuery,
} from "./kv/datalog/executor.js";
export { KvTriplesLive } from "./kv/layers/KvTriplesLive.js";
