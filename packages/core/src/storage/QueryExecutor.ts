/**
 * QueryExecutor - Backend-agnostic query execution interface
 *
 * This interface abstracts how Datalog queries are executed against storage.
 * SQL backends compile Datalog to SQL and execute via SqlClient.
 * KV backends execute directly using index intersection (hexastore pattern).
 *
 * The QueryExecutor is the key abstraction that enables non-SQL backends
 * like FoundationDB or SpacetimeDB to participate in Datalog query execution
 * without going through SQL.
 */

import { Context, Effect } from "effect";
import type { DatalogQueryError, ReadError } from "../errors/index.js";
import type { DatalogQuery, WrappedQuery } from "../datalog/types.js";
import type { ResolvedTemporalBasis } from "../Temporal.js";
import type { PaginationValue } from "../Pagination.js";

/**
 * Variable-to-value binding from query execution
 */
export type Constant = string | number | boolean | null;

/**
 * A single row of query results: variable names mapped to their bound values
 */
export interface QueryContext {
  readonly [variable: string]: Constant;
}

/**
 * Query result is an array of variable bindings
 */
export type QueryResult = readonly QueryContext[];

/**
 * Backend-agnostic query plan for debugging
 */
export interface QueryPlan {
  readonly backend: string;
  readonly steps: ReadonlyArray<{
    readonly label: string;
    readonly query: string;
    readonly params?: readonly unknown[];
  }>;
}

/**
 * Metrics about query compilation/execution.
 *
 * Core metrics (patternCount, predicateCount, etc.) are always present.
 * SQL-specific metrics (sqlLength, paramCount, cteCount, joinCount) are
 * optional — KV backends that don't generate SQL can omit them.
 */
export interface QueryMetrics {
  // --- Backend-agnostic metrics ---
  readonly patternCount: number;
  readonly predicateCount: number;
  readonly notClauseCount: number;
  readonly orClauseCount: number;
  readonly hasAggregation: boolean;
  readonly isRecursive: boolean;
  readonly aggregateOps: readonly string[];
  readonly compilationTimeMs: number;

  // --- SQL-specific metrics (optional for non-SQL backends) ---
  readonly joinCount?: number;
  readonly whereConditionCount?: number;
  readonly subqueryCount?: number;
  readonly cteCount?: number;
  readonly sqlLength?: number;
  readonly paramCount?: number;
}

/**
 * Debug information for query execution.
 *
 * SQL-specific fields (generatedSql, params) are optional — KV backends
 * that don't generate SQL can omit them.
 */
export interface QueryDebugInfo {
  readonly metrics: QueryMetrics;
  /** Main SQL plus optional count execution; excludes compilation and decoding. */
  readonly executionTimeMs: number;
  readonly countExecutionTimeMs?: number;
  readonly resultCount: number;
  readonly queryPlan?: QueryPlan;

  // --- SQL-specific debug info (optional for non-SQL backends) ---
  readonly generatedSql?: string;
  readonly params?: readonly unknown[];
}

/**
 * Wrapped query result with pagination
 */
export interface WrappedQueryResult {
  readonly results: QueryResult;
  readonly totalCount?: number;
  readonly nextCursor?: string;
  readonly debug?: QueryDebugInfo;
}

/**
 * QueryExecutorService - Execute Datalog queries against storage
 *
 * SQL backends (SQLite, PostgreSQL):
 *   Compile Datalog → SQL, execute via SqlClient, convert rows to QueryContext
 *
 * KV backends (FoundationDB, in-memory):
 *   Execute Datalog directly using hexastore index scans + nested loop joins
 */
export interface QueryExecutorService {
  /**
   * Execute a Datalog query, returning variable bindings.
   *
   * Implementations run the shared runtime and semantic preflight before
   * selecting their backend execution strategy.
   *
   * @param query - The (pre-validated) Datalog query
   * @param debug - Whether to include debug metrics
   * @returns Query results and optional debug info
   */
  readonly execute: (
    query: DatalogQuery,
    debug?: boolean,
    basis?: ResolvedTemporalBasis,
  ) => Effect.Effect<
    { results: QueryResult; debug?: QueryDebugInfo },
    ReadError | DatalogQueryError
  >;

  /**
   * Execute a wrapped query with pagination support.
   *
   * @param query - The wrapped query specification
   * @param debug - Whether to include debug metrics
   * @returns Results with optional total count and cursor
   */
  readonly executePage: (
    query: WrappedQuery,
    debug?: boolean,
    basis?: ResolvedTemporalBasis,
    cursorValues?: readonly PaginationValue[],
  ) => Effect.Effect<WrappedQueryResult, ReadError | DatalogQueryError>;

  /**
   * Explain a query plan without executing.
   *
   * @param query - The query to explain
   * @returns The query plan
   */
  readonly explain: (
    query: DatalogQuery,
  ) => Effect.Effect<
    { queryPlan: QueryPlan; metrics?: QueryMetrics },
    ReadError | DatalogQueryError
  >;

  /**
   * Explain a wrapped query plan without executing.
   *
   * @param query - The wrapped query to explain
   * @returns The query plan (may include multiple steps for main + count)
   */
  readonly explainPage: (
    query: WrappedQuery,
  ) => Effect.Effect<{ queryPlan: QueryPlan }, ReadError | DatalogQueryError>;
}

// =============================================================================
// Service Tag
// =============================================================================

/**
 * QueryExecutor service tag for dependency injection
 */
export class QueryExecutor extends Context.Service<QueryExecutor, QueryExecutorService>()(
  "QueryExecutor",
) {}
