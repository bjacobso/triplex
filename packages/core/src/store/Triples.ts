/**
 * Triples — the one service of the triple store.
 *
 * Writes, triple-pattern reads, and Datalog queries share one coherent service:
 *
 * ```ts
 * const person = EntityId.make("p1")
 * yield* triples.assert({ entityId: person, attribute: ":name", value: { type: "string", value: "Alice" } })
 * const facts = yield* triples.match({ entityId: person })             // triple pattern read
 * const { results } = yield* triples.query({ find: ["?n"], where: [["?p", ":name", "?n"]] }) // datalog read
 * ```
 *
 * `SnapshotService`, `SubscriptionManager`, and `DatabaseManager`
 * remain separate optional services — they have genuinely independent consumers.
 */

import { Context, Effect } from "effect";
import type {
  Triple,
  TripleInput,
  TripleId,
  EntityId,
  TransactOp,
  TransactionPrecondition,
} from "../Triple.js";
import type { TransactionId } from "../Branded.js";
import type { Pattern } from "../types/Pattern.js";
import type {
  WriteError,
  ReadError,
  DatalogQueryError,
  CommandAlreadyCommittedError,
  TransactionConflictError,
  ConstraintViolationError,
  PaginationCursorError,
} from "../errors/index.js";
import type { DatalogQuery, WrappedQuery } from "../datalog/types.js";
import type { TemporalBasis } from "../Temporal.js";
import type { TripleValue } from "../Value.js";
import type { Rule as ConstraintRule } from "../Constraint.js";
import type { EntityPageCursor, EntityPageRequest, EntityPageSnapshot } from "../EntityPage.js";
import type {
  QueryResult,
  QueryDebugInfo,
  QueryPlan,
  QueryMetrics,
  WrappedQueryResult,
} from "../storage/QueryExecutor.js";

// =============================================================================
// Result / options types (canonical home)
// =============================================================================

/**
 * Transaction result containing the transaction ID, asserted triples, and retraction count
 */
export interface TransactionResult {
  readonly txId: TransactionId;
  readonly position: number;
  readonly instant: number;
  readonly triples: readonly Triple[];
  readonly retracted: number;
}

/**
 * Transaction metadata options
 */
export interface TransactionMeta {
  readonly actor?: string;
  /** Atomically unique idempotency identity within this Triplex database. */
  readonly commandId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly configSnapshot?: string;
  /**
   * Portable constraints to enforce against the transaction's complete
   * post-state. Hosts normally derive these from the pinned config snapshot.
   */
  readonly enforce?: {
    readonly constraints: readonly ConstraintRule[];
  };
  /**
   * Serialized transaction preconditions. `TripleLive` references must also
   * have a matching `retract` operation; `EntityState` compares the complete
   * observed live fact-ID set. A mismatch fails the whole transaction with
   * `TransactionConflictError`.
   */
  readonly preconditions?: readonly TransactionPrecondition[];
}

export interface TransactionChange {
  readonly op: "assert" | "retract";
  readonly tripleId: TripleId;
  readonly entityId: EntityId;
  readonly attribute: string;
  /** Present on journals written by the bitemporal journal format. */
  readonly entityType?: string;
  /** The complete typed value, retained for assertions and retractions. */
  readonly value?: TripleValue;
  readonly validFrom?: number;
  readonly validTo?: number;
  readonly recordedAt?: number;
  readonly retractedAt?: number;
  readonly assertionTxId?: TransactionId;
  readonly retractionTxId?: TransactionId;
}

export interface TransactionRecord {
  readonly txId: TransactionId;
  readonly position: number;
  readonly instant: number;
  readonly actor?: string;
  readonly commandId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly configSnapshot?: string;
  readonly changes: readonly TransactionChange[];
}

export interface TransactionPageRequest {
  /** Return transactions strictly after this commit position. Defaults to 0. */
  readonly after?: number;
  /** Maximum number of transactions to return. Defaults to 100; maximum 1,000. */
  readonly limit?: number;
}

export interface TransactionPage {
  readonly transactions: readonly TransactionRecord[];
  /** Position of the final returned transaction, suitable for the next `after`. */
  readonly next?: number;
}

export interface EntityTransactionPageRequest {
  /** Maximum number of transactions to return. Defaults to 100; maximum 1,000. */
  readonly limit?: number;
  /** Commit-position snapshot returned by the first page. Omit on the first request. */
  readonly snapshotPosition?: number;
  /** Return transactions strictly before this position. */
  readonly beforePosition?: number;
}

export interface EntityTransactionPage {
  readonly transactions: readonly TransactionRecord[];
  /** Commit position captured by the first page and required for stable continuation. */
  readonly snapshotPosition: number;
  /** Exclusive position boundary for the next page, when more results exist. */
  readonly nextBeforePosition?: number;
}

export interface DependencyState {
  /** Latest assertion or retraction position for the selected attributes. */
  readonly sourcePosition: number;
  /** Earliest future valid-time edge in the selected attributes' recorded view. */
  readonly nextTemporalBoundary?: number;
}

export interface EntityPage {
  /** Complete entity bodies, ordered by entity identity, all read from one exact commit cut. */
  readonly entities: readonly (readonly Triple[])[];
  readonly snapshot: EntityPageSnapshot;
  readonly nextCursor?: EntityPageCursor;
}

/**
 * Options accepted by the Datalog read methods.
 */
export interface QueryOptions {
  /** Include debug metrics (generated SQL, timings, plan) in the response. */
  readonly debug?: boolean;
  /** Evaluate the complete query against one bitemporal basis. */
  readonly basis?: TemporalBasis;
}

/**
 * Response from a Datalog `query`: result bindings plus optional debug info.
 */
export interface QueryResponse {
  readonly results: QueryResult;
  readonly debug?: QueryDebugInfo;
}

/**
 * Response from a paged Datalog query (`queryPage`): result bindings, optional
 * total count, and a cursor for the next page.
 */
export type PagedQueryResponse = WrappedQueryResult;

/**
 * Result of explaining a query (compile without executing).
 */
export interface ExplainResult {
  readonly queryPlan: QueryPlan;
  readonly metrics?: QueryMetrics;
}

// =============================================================================
// Service shape
// =============================================================================

export interface TriplesService {
  // --- Writes (append-only semantics) --------------------------------------
  readonly assert: (input: TripleInput) => Effect.Effect<Triple, WriteError>;
  readonly assertBatch: (
    inputs: readonly TripleInput[],
  ) => Effect.Effect<readonly Triple[], WriteError>;
  readonly retract: (id: TripleId) => Effect.Effect<void, WriteError>;
  readonly retractByPattern: (pattern: Pattern) => Effect.Effect<number, WriteError | ReadError>;
  /** Group operations into a single atomic transaction with metadata. */
  readonly transact: (
    operations: readonly TransactOp[],
    meta?: TransactionMeta,
  ) => Effect.Effect<
    TransactionResult,
    | WriteError
    | ReadError
    | TransactionConflictError
    | CommandAlreadyCommittedError
    | ConstraintViolationError
  >;
  // --- Triple-level reads --------------------------------------------------
  /** Fetch a single triple by id. */
  readonly get: (id: TripleId) => Effect.Effect<Triple | null, ReadError>;
  /** Fetch all live triples for an entity. */
  readonly entity: (
    entityId: EntityId,
    basis?: TemporalBasis,
  ) => Effect.Effect<readonly Triple[], ReadError>;
  /** Batch entity materialization, preserving input order and missing entries. */
  readonly entities: (
    entityIds: readonly EntityId[],
    basis?: TemporalBasis,
  ) => Effect.Effect<readonly (readonly Triple[])[], ReadError>;
  readonly entityPage: (
    request: EntityPageRequest,
  ) => Effect.Effect<EntityPage, ReadError | PaginationCursorError>;
  /** Match triples against a pattern. */
  readonly match: (
    pattern: Pattern,
    basis?: TemporalBasis,
  ) => Effect.Effect<readonly Triple[], ReadError>;
  /** Full history (including retracted) for an entity. */
  readonly history: (entityId: EntityId) => Effect.Effect<readonly Triple[], ReadError>;
  /** Read a persisted causal transaction envelope and its fact changes. */
  readonly transaction: (txId: TransactionId) => Effect.Effect<TransactionRecord | null, ReadError>;
  /** Lookup the durable receipt for an atomically unique command ID. */
  readonly transactionByCommand: (
    commandId: string,
  ) => Effect.Effect<TransactionRecord | null, ReadError>;
  /** Read ordered transaction envelopes after a durable resume position. */
  readonly transactions: (
    request?: TransactionPageRequest,
  ) => Effect.Effect<TransactionPage, ReadError>;
  /** Read the authoritative journal entries that changed one entity, newest first. */
  readonly transactionsForEntity: (
    entityId: EntityId,
    request?: EntityTransactionPageRequest,
  ) => Effect.Effect<EntityTransactionPage, ReadError>;
  /** Latest committed backend position, including internal maintenance writes. */
  readonly currentPosition: () => Effect.Effect<number, ReadError>;
  /**
   * Indexed freshness and valid-time schedule for a fixed attribute dependency
   * set. An empty set has source position zero and no temporal boundary.
   */
  readonly dependencyState: (
    attributes: readonly string[],
    basis?: TemporalBasis,
  ) => Effect.Effect<DependencyState, ReadError>;

  // --- Datalog reads -------------------------------------------------------
  /** Execute a Datalog query. */
  readonly query: (
    query: DatalogQuery,
    options?: QueryOptions,
  ) => Effect.Effect<QueryResponse, ReadError | DatalogQueryError>;
  /** Execute a wrapped/paginated Datalog query. */
  readonly queryPage: (
    query: WrappedQuery,
    options?: QueryOptions,
  ) => Effect.Effect<PagedQueryResponse, ReadError | DatalogQueryError | PaginationCursorError>;
  /** Explain a Datalog query without executing it. */
  readonly explain: (query: DatalogQuery) => Effect.Effect<ExplainResult, DatalogQueryError>;
  /** Explain a wrapped Datalog query without executing it. */
  readonly explainPage: (query: WrappedQuery) => Effect.Effect<ExplainResult, DatalogQueryError>;
}

/**
 * The `Triples` service tag.
 *
 * Namespaced so the bare id can't collide with another library's tag when they
 * share an Effect context.
 */
export class Triples extends Context.Service<Triples, TriplesService>()("triplex/Triples") {}
