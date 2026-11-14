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
import {
  WriteError,
  ReadError,
  MigrationError,
  TransactionConflictError,
} from "../errors/index.js";
import type { DependencyState } from "../store/Triples.js";
import type { OperationalEntryRecord, PendingEntriesScan } from "../operational/Entry.js";
import type { ContentId } from "../content/ContentId.js";
import type { TransactionId } from "../Branded.js";
import type { JournalAppend, JournalEntry } from "../store/journal.js";

/**
 * StorageAdapterService - Backend-agnostic storage primitives
 */
export interface StorageAdapterService {
  /** Indexed unretracted assertions across all valid time at the current recorded cut. */
  readonly liveFacts: (entityId: string) => Effect.Effect<readonly TripleRow[], ReadError>;
  // --- Transaction journal ------------------------------------------------
  /**
   * Append the transaction's journal entry and its changed-entity rows inside
   * the current atomic transaction. The command ID is unique: when another
   * committed transaction already holds it, nothing is written and the
   * winner's transaction ID is returned; otherwise `null`.
   */
  readonly appendTransaction: (entry: JournalAppend) => Effect.Effect<string | null, WriteError>;
  /** One journal entry by transaction ID. */
  readonly transactionEntry: (txId: string) => Effect.Effect<JournalEntry | null, ReadError>;
  /** The journal entry holding a command ID. */
  readonly transactionEntryByCommand: (
    commandId: string,
  ) => Effect.Effect<JournalEntry | null, ReadError>;
  /**
   * Indexed journal page: entries committed after `after`, ordered by
   * position, at most `limit`. Must seek, not scan the whole journal.
   */
  readonly transactionEntriesAfter: (
    after: number,
    limit: number,
  ) => Effect.Effect<readonly JournalEntry[], ReadError>;
  /**
   * Entries after `after` that changed an entity whose ID starts with `prefix`
   * (literal, case-sensitive), ordered by position, deduplicated, at most `limit`.
   */
  readonly transactionEntriesForEntityPrefix: (
    prefix: string,
    after: number,
    limit: number,
  ) => Effect.Effect<readonly JournalEntry[], ReadError>;
  /**
   * Entries that changed one entity at or before `snapshotPosition` and before
   * `beforePosition` when given, newest first, at most `limit`.
   */
  readonly transactionEntriesForEntity: (
    entityId: string,
    snapshotPosition: number,
    beforePosition: number | undefined,
    limit: number,
  ) => Effect.Effect<readonly JournalEntry[], ReadError>;
  /** Batched primary-key read of facts, retracted or not, for journal hydration. */
  readonly getByIds: (ids: readonly string[]) => Effect.Effect<readonly TripleRow[], ReadError>;
  /** Bounded live (unretracted, across all valid time) lookup using a live index. */
  readonly livePreconditionFacts: (
    entityId: string,
    attribute: string | undefined,
    limit: 1 | 2,
  ) => Effect.Effect<readonly TripleRow[], ReadError>;
  /** Point lookup by content ID; includes acknowledged history. */
  readonly getOperationalEntry: (
    id: ContentId,
  ) => Effect.Effect<OperationalEntryRecord | null, ReadError>;
  /** Pending-only indexed range, ordered by append position then ASCII ID, bounded by scan.limit. */
  readonly pendingOperationalEntries: (
    scan: PendingEntriesScan,
  ) => Effect.Effect<readonly OperationalEntryRecord[], ReadError>;
  /** These mutations run inside the caller's existing atomic transaction. */
  readonly insertOperationalEntry: (
    entry: OperationalEntryRecord,
  ) => Effect.Effect<void, WriteError>;
  readonly acknowledgeOperationalEntry: (
    id: ContentId,
    position: number,
    instant: number,
    txId: TransactionId,
  ) => Effect.Effect<void, WriteError>;
  readonly withTransaction: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | WriteError | TransactionConflictError>;
  /** Allocate the next ordered commit position inside the current transaction. */
  readonly nextCommitPosition: () => Effect.Effect<number, WriteError>;
  /** Read the latest committed position for an exact read snapshot boundary. */
  readonly currentCommitPosition: () => Effect.Effect<number, ReadError>;
  /** Greatest journal position whose instant is at or before `instant`, bounded by a captured head. */
  readonly recordedPositionAt: (instant: number, head: number) => Effect.Effect<number, ReadError>;
  readonly dependencyStateAll: (
    basis: ResolvedTemporalBasis,
  ) => Effect.Effect<DependencyState, ReadError>;
  /** Indexed projection freshness and valid-time scheduling for fixed attributes. */
  readonly dependencyState: (
    attributes: readonly string[],
    basis: ResolvedTemporalBasis,
  ) => Effect.Effect<DependencyState, ReadError>;
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
  /** Identity lookup; includeRetracted selects retained history instead of live state. */
  readonly getById: (
    id: string,
    includeRetracted?: boolean,
  ) => Effect.Effect<TripleRow | null, ReadError>;
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
