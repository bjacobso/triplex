/**
 * StorageAdapter - Backend-agnostic storage interface
 *
 * Abstracts low-level storage operations allowing different backends
 * (SQLite, PostgreSQL, Cloudflare DO, FoundationDB, etc.) to use
 * their optimal primitives.
 */

import { Context, Effect } from "effect";
import type { TripleInput, TripleRow, QueryPattern } from "./types.js";
import type { ResolvedTemporalBasis } from "../Temporal.js";
import { WriteError, ReadError, MigrationError } from "../errors/index.js";
import type { DependencyState } from "../store/Triples.js";

/**
 * StorageAdapterService - Backend-agnostic storage primitives
 */
export interface StorageAdapterService {
  readonly withTransaction: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E | WriteError>;
  /** Allocate the next ordered commit position inside the current transaction. */
  readonly nextCommitPosition: () => Effect.Effect<number, WriteError>;
  /** Read the latest committed position for an exact read snapshot boundary. */
  readonly currentCommitPosition: () => Effect.Effect<number, ReadError>;
  /** Indexed projection freshness and valid-time scheduling for fixed attributes. */
  readonly dependencyState: (
    attributes: readonly string[],
    basis: ResolvedTemporalBasis,
  ) => Effect.Effect<DependencyState, ReadError>;
  /**
   * Atomically reserve a command idempotency identity inside the current
   * transaction. Returns the original transaction id when it was already
   * reserved, or `null` when this transaction acquired it.
   */
  readonly claimCommand: (
    commandId: string,
    transactionId: string,
    timestamp: number,
  ) => Effect.Effect<string | null, WriteError>;
  readonly insert: (
    input: TripleInput,
    txId: string | null,
    timestamp: number,
    id: string,
    position: number,
  ) => Effect.Effect<TripleRow, WriteError>;
  readonly batchInsert: (
    inputs: readonly TripleInput[],
    txId: string,
    timestamp: number,
    ids: readonly string[],
    position: number,
  ) => Effect.Effect<readonly TripleRow[], WriteError>;
  readonly retract: (
    id: string,
    timestamp: number,
    txId: string,
    position: number,
  ) => Effect.Effect<boolean, WriteError>;
  readonly getById: (id: string) => Effect.Effect<TripleRow | null, ReadError>;
  readonly getByEntity: (
    entityId: string,
    basis?: ResolvedTemporalBasis,
  ) => Effect.Effect<readonly TripleRow[], ReadError>;
  readonly getByEntities: (
    entityIds: readonly string[],
    basis?: ResolvedTemporalBasis,
  ) => Effect.Effect<ReadonlyMap<string, readonly TripleRow[]>, ReadError>;
  readonly query: (
    pattern: QueryPattern,
    basis?: ResolvedTemporalBasis,
  ) => Effect.Effect<readonly TripleRow[], ReadError>;
  readonly history: (entityId: string) => Effect.Effect<readonly TripleRow[], ReadError>;
  readonly initialize: () => Effect.Effect<void, MigrationError>;
  readonly close: () => Effect.Effect<void, unknown>;
}

/** SQL-only refinement used by SQL snapshot persistence, never required by a runtime. */
export interface SqlStorageAdapterService extends StorageAdapterService {
  readonly rawQuery: <T extends object>(
    sql: string,
    params: readonly unknown[],
  ) => Effect.Effect<readonly T[], ReadError>;
}

export const isSqlStorageAdapter = (
  adapter: StorageAdapterService,
): adapter is SqlStorageAdapterService =>
  "rawQuery" in adapter && typeof adapter.rawQuery === "function";

/**
 * StorageAdapter service tag for dependency injection
 */
export class StorageAdapter extends Context.Service<StorageAdapter, StorageAdapterService>()(
  "StorageAdapter",
) {}
