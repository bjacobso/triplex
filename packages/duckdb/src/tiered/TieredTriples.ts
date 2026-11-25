/**
 * TieredTriples — `Triples` decorator routing reads across hot SQL and cold DuckDB/Parquet.
 *
 * Implements §5 and §6 of `docs/rfcs/cold-tier-duckdb.md`:
 * - Composes `TieredQueryExecutor` for Datalog `query`, `queryPage`, `queryAll`, `explain`,
 *   and `explainPage`, preserving opaque pagination cursors seamlessly across watermark `W`.
 * - Routes `history`, `assertion`, historical `entity`/`entities`/`match`, `resolveRecordedBasis`,
 *   `transaction`, `transactionByCommand`, `transactions`, and `transactionsForEntity` across
 *   hot + cold federated DuckDB views so `[tripleId, op]` journal change references and `Why`
 *   explanations resolve transparently after compaction.
 * - Propagates `scrubBlindTokens` erasure tombstones to the cold DuckDB view layer.
 */

import { Clock, Effect, Layer, Option } from "effect";
import {
  DatalogError,
  DatalogValidationError,
  DuckDbDialect,
  PaginationCursorError,
  ReadError,
  Triples,
  TripleStoreRuntime,
  UnboundVariableError,
  WriteError,
  createParamCollector,
  finishPagination,
  preparePagination,
  resolveTemporalBasis,
  validateDatalogQuery,
  validateWrappedQuery,
  type Attribute,
  type DatalogQuery,
  type EntityId,
  type JournalEntry,
  type PagedQueryOptions,
  type Pattern,
  type QueryExecutorService,
  type QueryOptions,
  type ResolvedTemporalBasis,
  type SealableValueType,
  type TemporalBasis,
  type TransactionChange,
  type TransactionId,
  type TransactionRecord,
  type Triple,
  type TripleId,
  type TripleRow,
  type TripleValue,
  type WrappedQuery,
  type TriplesService,
} from "@triplex-internal/core/internal";
import { makeSqlTransactionJournal, type SqlStatementRunner } from "@triplex-build/triplex-sql";
import { makeDuckDbQueryExecutor } from "../DuckDbQueryExecutor.js";
import { recordColdErasedKeys } from "./FederatedViews.js";
import {
  decideTierRoute,
  makeTieredQueryExecutor,
  type TierRoutingDecision,
  type TierRoutingPolicy,
} from "./TieredQueryExecutor.js";

// =============================================================================
// Options
// =============================================================================

export interface TieredTriplesOptions {
  /** DuckDB statement runner configured with federated views (`setupFederatedViews`). */
  readonly federatedRunner: SqlStatementRunner;
  /** Durable compaction watermark `W` (0 when no cold segments exist). */
  readonly watermark: Effect.Effect<number, ReadError>;
  /**
   * Database scope string matching the hot `Triples` runtime scope so opaque
   * pagination cursors continue seamlessly across `W`. When omitted, reads from
   * `TripleStoreRuntime` if present in the Effect context, else `"default"`.
   */
  readonly scope?: string;
  /**
   * Optional hot `QueryExecutorService`. When provided, `TieredQueryExecutor`
   * wraps `hotQueryExecutor` directly; otherwise hot Datalog calls delegate to
   * the inner `Triples` service.
   */
  readonly hotQueryExecutor?: QueryExecutorService;
  /** Optional explicit upper bound on `recorded_at`/`retracted_at` of rows at `<= W`. */
  readonly watermarkInstant?: Effect.Effect<number | undefined, ReadError>;
  /** Prefer routing Datalog queries through the federated DuckDB executor. */
  readonly preferAnalyticalCold?: boolean;
  /** Optional observer called on every Datalog tier routing decision. */
  readonly onRoute?: (decision: TierRoutingDecision) => void;
  /**
   * Optional hook run before any federated DuckDB read (e.g. to sync in-memory
   * hot tables or refresh federated views when a new manifest is published).
   */
  readonly beforeFederatedRead?: Effect.Effect<void, ReadError>;
}

// =============================================================================
// Row & Journal Conversion Helpers
// =============================================================================

const decodeSealedEnvelope = (encoded: string, blind: string | null | undefined): TripleValue => {
  const parsed = JSON.parse(encoded) as {
    readonly valueType: SealableValueType;
    readonly keyId: string;
    readonly ciphertext: string;
  };
  return {
    type: "sealed",
    valueType: parsed.valueType,
    keyId: parsed.keyId,
    ciphertext: parsed.ciphertext,
    ...(blind === null || blind === undefined ? {} : { blind }),
  };
};

const withoutBlind = (value: TripleValue): TripleValue => {
  if (value.type !== "sealed" || value.blind === undefined) return value;
  const { blind: _blind, ...rest } = value;
  return rest;
};

const rowToTriple = (row: TripleRow): Triple => {
  let value: Triple["value"];
  switch (row.value_type) {
    case "string":
      value = { type: "string", value: row.value_string ?? "" };
      break;
    case "number":
      value = { type: "number", value: Number(row.value_number ?? 0) };
      break;
    case "boolean":
      value = {
        type: "boolean",
        value:
          row.value_boolean === 1 ||
          (row.value_boolean as unknown) === true ||
          (row.value_boolean as unknown) === 1n,
      };
      break;
    case "datetime":
      value = { type: "datetime", value: Number(row.value_datetime ?? 0) };
      break;
    case "ref":
      value = { type: "ref", value: (row.value_string ?? "") as EntityId };
      break;
    case "json":
      value = { type: "json", value: row.value_json ? JSON.parse(row.value_json) : null };
      break;
    case "blob": {
      const meta = row.value_json ? JSON.parse(row.value_json) : {};
      value = {
        type: "blob",
        value: row.value_string ?? "",
        mimeType: meta.mimeType ?? "application/octet-stream",
        size: meta.size ?? 0,
        ...(meta.filename && { filename: meta.filename }),
      };
      break;
    }
    case "sealed":
      value = decodeSealedEnvelope(row.value_sealed ?? "{}", row.value_blind);
      break;
    default:
      value = { type: "string", value: "" };
  }

  return {
    id: row.id as TripleId,
    entityId: row.entity_id as EntityId,
    attribute: row.attribute as Attribute,
    value,
    recordedAt: Number(row.recorded_at),
    validFrom: Number(row.valid_from),
    validTo:
      row.valid_to !== null && row.valid_to !== undefined
        ? Option.some(Number(row.valid_to))
        : Option.none(),
    createdBy: row.created_by ? Option.some(row.created_by) : Option.none(),
    retractedAt:
      row.retracted_at !== null && row.retracted_at !== undefined
        ? Option.some(Number(row.retracted_at))
        : Option.none(),
    entityType: row.entity_type ? Option.some(row.entity_type) : Option.none(),
    schemaVersion:
      row.schema_version !== null && row.schema_version !== undefined
        ? Option.some(Number(row.schema_version))
        : Option.none(),
    txId: row.tx_id ? Option.some(row.tx_id as TransactionId) : Option.none(),
    retractTxId: row.retract_tx_id
      ? Option.some(row.retract_tx_id as TransactionId)
      : Option.none(),
  };
};

const tripleAtRecordedPosition = (triple: Triple, position?: number): Triple =>
  position === undefined
    ? triple
    : {
        ...triple,
        retractedAt: Option.none(),
        retractTxId: Option.none(),
      };

const wrapDatalogQuery = (
  query: DatalogQuery,
  options?: { readonly pageSize?: number; readonly cursor?: string },
): WrappedQuery => ({
  inner: query,
  ...(query.orderBy === undefined ? {} : { orderBy: query.orderBy }),
  ...(options?.pageSize === undefined ? {} : { limit: options.pageSize }),
  ...(options?.cursor === undefined ? {} : { cursor: options.cursor }),
});

const resolveQueryBasisForTier = (
  query: DatalogQuery,
  basis: TemporalBasis | undefined,
  now: number,
): {
  readonly recordedAt?: number;
  readonly recordedPosition?: number;
  readonly validAt?: number;
} => {
  if (query.validTime === "all" && basis?.validAt !== undefined) {
    throw new DatalogValidationError({
      message: "validTime all cannot be combined with explicit validAt",
      code: "datalog.invalid-temporal-basis",
      path: "basis.validAt",
      fix: "Remove validAt or use validTime point.",
      query,
    });
  }
  if (query.validTime !== "all") return resolveTemporalBasis(basis, now);
  return {
    ...(basis?.recordedAt === undefined ? {} : { recordedAt: basis.recordedAt }),
    ...(basis?.recordedPosition === undefined ? {} : { recordedPosition: basis.recordedPosition }),
  };
};

const transactionChangeFromTriple = (
  op: "assert" | "retract",
  triple: Triple,
  transactionId: TransactionId,
  transactionInstant: number,
): TransactionChange => ({
  op,
  tripleId: triple.id,
  entityId: triple.entityId,
  attribute: triple.attribute,
  ...(Option.isSome(triple.entityType) ? { entityType: triple.entityType.value } : {}),
  value: withoutBlind(triple.value),
  validFrom: triple.validFrom,
  ...(Option.isSome(triple.validTo) ? { validTo: triple.validTo.value } : {}),
  recordedAt: triple.recordedAt,
  ...(op === "retract" ? { retractedAt: transactionInstant } : {}),
  ...(Option.isSome(triple.txId) ? { assertionTxId: triple.txId.value } : {}),
  ...(op === "retract" ? { retractionTxId: transactionId } : {}),
});

const transactionRecordFromEntry = (
  entry: JournalEntry,
  facts: ReadonlyMap<string, Triple>,
): TransactionRecord | { readonly missing: string } => {
  const txId = entry.txId as TransactionId;
  const changes: TransactionChange[] = [];
  for (const [tripleId, op] of entry.changes) {
    const fact = facts.get(tripleId);
    if (fact === undefined) return { missing: tripleId };
    changes.push(transactionChangeFromTriple(op, fact, txId, entry.instant));
  }
  return {
    txId,
    position: entry.position,
    instant: entry.instant,
    ...(entry.actor === undefined ? {} : { actor: entry.actor }),
    ...(entry.commandId === undefined ? {} : { commandId: entry.commandId }),
    ...(entry.correlationId === undefined ? {} : { correlationId: entry.correlationId }),
    ...(entry.causationId === undefined ? {} : { causationId: entry.causationId }),
    ...(entry.configSnapshot === undefined ? {} : { configSnapshot: entry.configSnapshot }),
    changes,
  };
};

// =============================================================================
// Federated Triple Query Helpers
// =============================================================================

const appendTemporalPredicates = (
  conditions: string[],
  p: ReturnType<typeof createParamCollector>,
  resolved: ResolvedTemporalBasis,
): void => {
  if (resolved.recordedPosition !== undefined) {
    const pos = p.add(resolved.recordedPosition);
    conditions.push(`recorded_position <= ${pos}`);
    if (resolved.recordedAt !== undefined) {
      const recAt = p.add(resolved.recordedAt);
      conditions.push(`recorded_at <= ${recAt}`);
      conditions.push(
        `(retracted_position IS NULL OR retracted_position > ${pos} OR retracted_at > ${recAt})`,
      );
    } else {
      conditions.push(`(retracted_position IS NULL OR retracted_position > ${pos})`);
    }
  } else if (resolved.recordedAt !== undefined) {
    const recAt = p.add(resolved.recordedAt);
    conditions.push(`recorded_at <= ${recAt}`);
    conditions.push(`(retracted_at IS NULL OR retracted_at > ${recAt})`);
  } else {
    conditions.push("retracted_at IS NULL");
  }

  const validAt = p.add(resolved.validAt);
  conditions.push(`valid_from <= ${validAt}`);
  conditions.push(`(valid_to IS NULL OR valid_to > ${validAt})`);
};

const appendPatternPredicates = (
  conditions: string[],
  p: ReturnType<typeof createParamCollector>,
  pattern: Pattern,
): void => {
  if (typeof pattern.entityId === "string") {
    conditions.push(`entity_id = ${p.add(pattern.entityId)}`);
  }
  if (typeof pattern.attribute === "string") {
    conditions.push(`attribute = ${p.add(pattern.attribute)}`);
  }
  if (pattern.entityType !== undefined) {
    conditions.push(`entity_type = ${p.add(pattern.entityType)}`);
  }
  if (pattern.value !== undefined && !("_tag" in pattern.value)) {
    const v = pattern.value;
    conditions.push(`value_type = ${p.add(v.type)}`);
    switch (v.type) {
      case "string":
      case "ref":
      case "blob":
        conditions.push(`value_string = ${p.add(v.value)}`);
        break;
      case "number":
        conditions.push(`value_number = ${p.add(v.value)}`);
        break;
      case "boolean":
        conditions.push(`value_boolean = ${p.add(v.value ? 1 : 0)}`);
        break;
      case "datetime":
        conditions.push(`value_datetime = ${p.add(v.value)}`);
        break;
      case "json":
        conditions.push(`value_json = ${p.add(JSON.stringify(v.value))}`);
        break;
      case "sealed":
        if (v.blind !== undefined) {
          conditions.push(`value_blind = ${p.add(v.blind)}`);
        } else {
          conditions.push("1 = 0");
        }
        break;
    }
  }
};

// =============================================================================
// TieredTriples Construction
// =============================================================================

/**
 * Decorate a hot `TriplesService` with watermark-aware tiered routing and
 * hot + cold federated DuckDB execution.
 */
export const makeTieredTriples = (
  hot: TriplesService,
  options: TieredTriplesOptions,
  runtimeScope?: string,
  runtimeNow?: Effect.Effect<number>,
): TriplesService => {
  const { federatedRunner, watermark: readWatermark } = options;
  const scope = options.scope ?? runtimeScope ?? "default";
  const now = runtimeNow ?? Clock.currentTimeMillis;

  const prepFederated: Effect.Effect<void, ReadError> = options.beforeFederatedRead ?? Effect.void;

  // Wrap federatedRunner so beforeFederatedRead runs before any DuckDB query.
  const syncedRunner: SqlStatementRunner = {
    run: <Row extends Record<string, unknown>>(sql: string, params: readonly unknown[]) =>
      prepFederated.pipe(Effect.flatMap(() => federatedRunner.run<Row>(sql, params))),
  };

  const federatedExecutor = makeDuckDbQueryExecutor(syncedRunner);
  const federatedJournal = makeSqlTransactionJournal(syncedRunner, DuckDbDialect);

  // Cache max transaction instant per watermark W (transactions <= W are immutable).
  let cachedWatermark = -1;
  let cachedWatermarkInstant: number | undefined;

  const resolveWatermarkInstant = (w: number): Effect.Effect<number | undefined, ReadError> => {
    if (options.watermarkInstant !== undefined) {
      return options.watermarkInstant;
    }
    if (w <= 0) return Effect.succeed(undefined);
    if (cachedWatermark === w) return Effect.succeed(cachedWatermarkInstant);
    return syncedRunner
      .run<{ readonly max_instant: number | bigint | string | null }>(
        "SELECT MAX(instant) AS max_instant FROM triplex_transactions WHERE position <= $1",
        [w],
      )
      .pipe(
        Effect.map((rows) => {
          const raw = rows[0]?.max_instant;
          const instant = raw === null || raw === undefined ? undefined : Number(raw);
          cachedWatermark = w;
          cachedWatermarkInstant = instant;
          return instant;
        }),
        Effect.mapError(
          (cause) =>
            new ReadError({
              message: `Failed to read cold watermark instant: ${String(cause)}`,
              cause,
            }),
        ),
      );
  };

  const routingPolicy: TierRoutingPolicy = {
    watermark: readWatermark,
    watermarkInstant: readWatermark.pipe(Effect.flatMap(resolveWatermarkInstant)),
    ...(options.preferAnalyticalCold === undefined
      ? {}
      : { preferAnalyticalCold: options.preferAnalyticalCold }),
    ...(options.onRoute === undefined ? {} : { onRoute: options.onRoute }),
  };

  const tieredExecutor: QueryExecutorService | undefined = options.hotQueryExecutor
    ? makeTieredQueryExecutor({
        hot: options.hotQueryExecutor,
        federated: federatedExecutor,
        policy: routingPolicy,
      })
    : undefined;

  const needsFederatedForBasis = (
    basis: TemporalBasis | undefined,
  ): Effect.Effect<boolean, ReadError> =>
    Effect.gen(function* () {
      const w = yield* readWatermark;
      if (w <= 0) return false;
      if (basis?.recordedPosition !== undefined) {
        return basis.recordedPosition <= w;
      }
      if (basis?.recordedAt !== undefined) {
        const wInstant = yield* resolveWatermarkInstant(w);
        return wInstant === undefined || basis.recordedAt < wInstant;
      }
      return false;
    });

  // ---------------------------------------------------------------------------
  // Federated Journal Hydration
  // ---------------------------------------------------------------------------

  const hydrateFederated = (
    entries: readonly JournalEntry[],
  ): Effect.Effect<readonly TransactionRecord[], ReadError> =>
    Effect.gen(function* () {
      const ids = [
        ...new Set(entries.flatMap((entry) => entry.changes.map(([tripleId]) => tripleId))),
      ];
      const rows = ids.length === 0 ? [] : yield* federatedJournal.getByIds(ids);
      const facts = new Map(rows.map((row) => [row.id, rowToTriple(row)] as const));
      return yield* Effect.forEach(entries, (entry) => {
        const record = transactionRecordFromEntry(entry, facts);
        return "missing" in record
          ? Effect.fail(
              new ReadError({
                message: `Transaction ${entry.txId} references missing fact ${record.missing}`,
              }),
            )
          : Effect.succeed(record);
      });
    });

  // ---------------------------------------------------------------------------
  // Triple-level Reads Across Hot + Cold
  // ---------------------------------------------------------------------------

  const assertion: TriplesService["assertion"] = (id) =>
    Effect.gen(function* () {
      const fromHot = yield* hot.assertion(id);
      if (fromHot !== null) return fromHot;
      const w = yield* readWatermark;
      if (w <= 0) return null;
      const rows = yield* syncedRunner
        .run<TripleRow & Record<string, unknown>>("SELECT * FROM triples WHERE id = $1 LIMIT 1", [
          id,
        ])
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReadError({
                message: `Failed to read cold assertion ${id}: ${String(cause)}`,
                cause,
              }),
          ),
        );
      return rows[0] ? rowToTriple(rows[0]) : null;
    });

  const history: TriplesService["history"] = (entityId) =>
    Effect.gen(function* () {
      const w = yield* readWatermark;
      if (w <= 0) return yield* hot.history(entityId);
      const rows = yield* syncedRunner
        .run<TripleRow & Record<string, unknown>>(
          "SELECT * FROM triples WHERE entity_id = $1 ORDER BY recorded_at ASC, recorded_position ASC, id ASC",
          [entityId],
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReadError({
                message: `Failed to read federated history for ${entityId}: ${String(cause)}`,
                cause,
              }),
          ),
        );
      return rows.map(rowToTriple);
    });

  const entity: TriplesService["entity"] = (entityId, basis) =>
    Effect.gen(function* () {
      if (!(yield* needsFederatedForBasis(basis))) {
        return yield* hot.entity(entityId, basis);
      }
      const resolved = resolveTemporalBasis(basis, yield* now);
      const p = createParamCollector(DuckDbDialect);
      const conditions = [`entity_id = ${p.add(entityId)}`];
      appendTemporalPredicates(conditions, p, resolved);
      const rows = yield* syncedRunner
        .run<TripleRow & Record<string, unknown>>(
          `SELECT * FROM triples WHERE ${conditions.join(" AND ")}`,
          p.params,
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReadError({
                message: `Failed to read federated entity ${entityId}: ${String(cause)}`,
                cause,
              }),
          ),
        );
      return rows.map((row) => tripleAtRecordedPosition(rowToTriple(row), basis?.recordedPosition));
    });

  const entities: TriplesService["entities"] = (entityIds, basis) =>
    Effect.gen(function* () {
      if (entityIds.length === 0) return [];
      if (!(yield* needsFederatedForBasis(basis))) {
        return yield* hot.entities(entityIds, basis);
      }
      const resolved = resolveTemporalBasis(basis, yield* now);
      const p = createParamCollector(DuckDbDialect);
      const placeholders = entityIds.map((id) => p.add(id)).join(", ");
      const conditions = [`entity_id IN (${placeholders})`];
      appendTemporalPredicates(conditions, p, resolved);
      const rows = yield* syncedRunner
        .run<TripleRow & Record<string, unknown>>(
          `SELECT * FROM triples WHERE ${conditions.join(" AND ")}`,
          p.params,
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReadError({
                message: `Failed to read federated entities: ${String(cause)}`,
                cause,
              }),
          ),
        );
      const grouped = new Map<string, Triple[]>();
      for (const row of rows) {
        const list = grouped.get(row.entity_id) ?? [];
        list.push(tripleAtRecordedPosition(rowToTriple(row), basis?.recordedPosition));
        grouped.set(row.entity_id, list);
      }
      return entityIds.map((id) => grouped.get(id) ?? []);
    });

  const match: TriplesService["match"] = (pattern, basis) =>
    Effect.gen(function* () {
      if (!(yield* needsFederatedForBasis(basis))) {
        return yield* hot.match(pattern, basis);
      }
      const resolved = resolveTemporalBasis(basis, yield* now);
      const p = createParamCollector(DuckDbDialect);
      const conditions: string[] = [];
      appendPatternPredicates(conditions, p, pattern);
      appendTemporalPredicates(conditions, p, resolved);
      const rows = yield* syncedRunner
        .run<TripleRow & Record<string, unknown>>(
          `SELECT * FROM triples WHERE ${conditions.join(" AND ")}`,
          p.params,
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReadError({
                message: `Failed to match federated triples: ${String(cause)}`,
                cause,
              }),
          ),
        );
      return rows.map((row) => tripleAtRecordedPosition(rowToTriple(row), basis?.recordedPosition));
    });

  // ---------------------------------------------------------------------------
  // Journal Reads Across Hot + Cold
  // ---------------------------------------------------------------------------

  const transaction: TriplesService["transaction"] = (txId) =>
    Effect.gen(function* () {
      const fromHot = yield* hot.transaction(txId);
      if (fromHot !== null) return fromHot;
      const w = yield* readWatermark;
      if (w <= 0) return null;
      const entry = yield* federatedJournal.transactionEntry(txId);
      if (entry === null) return null;
      const [record] = yield* hydrateFederated([entry]);
      return record ?? null;
    });

  const transactionByCommand: TriplesService["transactionByCommand"] = (commandId) =>
    Effect.gen(function* () {
      const fromHot = yield* hot.transactionByCommand(commandId);
      if (fromHot !== null) return fromHot;
      const w = yield* readWatermark;
      if (w <= 0) return null;
      const entry = yield* federatedJournal.transactionEntryByCommand(commandId);
      if (entry === null) return null;
      const [record] = yield* hydrateFederated([entry]);
      return record ?? null;
    });

  const transactions: TriplesService["transactions"] = (request = {}) =>
    Effect.gen(function* () {
      const after = request.after ?? 0;
      const limit = request.limit ?? 100;
      const prefix = request.entityIdPrefix;
      if (!Number.isSafeInteger(after) || after < 0) {
        return yield* Effect.fail(
          new ReadError({ message: "Transaction cursor must be a non-negative integer" }),
        );
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        return yield* Effect.fail(
          new ReadError({ message: "Transaction page limit must be between 1 and 1000" }),
        );
      }
      if (prefix !== undefined && typeof prefix !== "string") {
        return yield* Effect.fail(
          new ReadError({ message: "Transaction entityIdPrefix must be a string" }),
        );
      }

      const w = yield* readWatermark;
      if (w <= 0 || after >= w) {
        return yield* hot.transactions(request);
      }

      const entries =
        prefix === undefined
          ? yield* federatedJournal.transactionEntriesAfter(after, limit)
          : yield* federatedJournal.transactionEntriesForEntityPrefix(prefix, after, limit);
      const page = yield* hydrateFederated(entries);
      return {
        transactions: page,
        ...(page.length === 0 ? {} : { next: page.at(-1)!.position }),
      };
    });

  const transactionsForEntity: TriplesService["transactionsForEntity"] = (entityId, request = {}) =>
    Effect.gen(function* () {
      const limit = request.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        return yield* Effect.fail(
          new ReadError({ message: "Entity transaction page limit must be between 1 and 1000" }),
        );
      }
      if (
        request.snapshotPosition !== undefined &&
        (!Number.isSafeInteger(request.snapshotPosition) || request.snapshotPosition < 0)
      ) {
        return yield* Effect.fail(
          new ReadError({
            message: "Entity transaction snapshot position must be a non-negative integer",
          }),
        );
      }
      if (
        request.beforePosition !== undefined &&
        (!Number.isSafeInteger(request.beforePosition) || request.beforePosition < 0)
      ) {
        return yield* Effect.fail(
          new ReadError({
            message: "Entity transaction page boundary must be a non-negative integer",
          }),
        );
      }

      const w = yield* readWatermark;
      if (w <= 0) {
        return yield* hot.transactionsForEntity(entityId, request);
      }

      const snapshotPosition = request.snapshotPosition ?? (yield* hot.currentPosition());
      const indexed = yield* federatedJournal.transactionEntriesForEntity(
        entityId,
        snapshotPosition,
        request.beforePosition,
        limit + 1,
      );
      const records = yield* hydrateFederated(indexed.slice(0, limit));
      const last = records.at(-1);
      return {
        transactions: records,
        snapshotPosition,
        ...(indexed.length > limit && last !== undefined
          ? { nextBeforePosition: last.position }
          : {}),
      };
    });

  const resolveRecordedBasis: TriplesService["resolveRecordedBasis"] = (basis) =>
    Effect.gen(function* () {
      const w = yield* readWatermark;
      if (w <= 0 || basis?.recordedAt === undefined) {
        return yield* hot.resolveRecordedBasis(basis);
      }
      const head = yield* hot.currentPosition();
      const recordedPosition = yield* federatedJournal.recordedPositionAt(basis.recordedAt, head);
      return { recordedPosition };
    });

  // ---------------------------------------------------------------------------
  // Datalog Reads (Tiered Routing + Seamless Cursor Continuation Across W)
  // ---------------------------------------------------------------------------

  const queryAll: TriplesService["queryAll"] = (q: DatalogQuery, queryOptions?: QueryOptions) =>
    Effect.gen(function* () {
      const validated = yield* validateDatalogQuery(q);
      const currentTime = yield* now;
      const basis = yield* Effect.try({
        try: () => resolveQueryBasisForTier(validated, queryOptions?.basis, currentTime),
        catch: (cause) =>
          cause instanceof DatalogValidationError
            ? cause
            : new DatalogValidationError({ message: String(cause), query: q }),
      });
      const recordedPosition = basis.recordedPosition ?? (yield* hot.currentPosition());
      const fullBasis = { ...basis, recordedPosition };

      if (tieredExecutor !== undefined) {
        return yield* tieredExecutor.execute(validated, queryOptions?.debug ?? false, fullBasis);
      }

      const w = yield* readWatermark;
      const wInstant =
        !options.preferAnalyticalCold && w > 0 && fullBasis.recordedAt !== undefined
          ? yield* resolveWatermarkInstant(w)
          : undefined;
      const decision = decideTierRoute({
        query: validated,
        watermark: w,
        watermarkInstant: wInstant,
        basis: fullBasis,
        preferAnalyticalCold: options.preferAnalyticalCold,
      });
      options.onRoute?.(decision);

      if (decision.target === "hot") {
        return yield* hot.queryAll(q, queryOptions);
      }
      return yield* federatedExecutor.execute(validated, queryOptions?.debug ?? false, fullBasis);
    });

  const queryPage: TriplesService["queryPage"] = (q: WrappedQuery, queryOptions?: QueryOptions) =>
    Effect.gen(function* () {
      const validated = yield* validateWrappedQuery(q);
      const currentTime = yield* now;
      const head = yield* hot.currentPosition();
      const prepared = yield* Effect.try({
        try: () =>
          preparePagination({
            query: validated,
            ...(queryOptions?.basis === undefined ? {} : { basis: queryOptions.basis }),
            now: currentTime,
            recordedPosition: head,
            scope,
          }),
        catch: (cause) =>
          cause instanceof PaginationCursorError || cause instanceof DatalogValidationError
            ? cause
            : new PaginationCursorError({
                reason: "malformed",
                message: `Failed to prepare pagination: ${String(cause)}`,
                cause,
              }),
      });

      if (tieredExecutor !== undefined) {
        const result = yield* tieredExecutor.executePage(
          prepared.query,
          queryOptions?.debug ?? false,
          prepared.basis,
          prepared.cursorValues,
        );
        return finishPagination(prepared, result);
      }

      const w = yield* readWatermark;
      const wInstant =
        !options.preferAnalyticalCold && w > 0 && prepared.basis.recordedAt !== undefined
          ? yield* resolveWatermarkInstant(w)
          : undefined;
      const decision = decideTierRoute({
        query: prepared.query.inner,
        watermark: w,
        watermarkInstant: wInstant,
        basis: prepared.basis,
        preferAnalyticalCold: options.preferAnalyticalCold,
      });
      options.onRoute?.(decision);

      if (decision.target === "hot") {
        return yield* hot.queryPage(q, queryOptions);
      }

      const result = yield* federatedExecutor.executePage(
        prepared.query,
        queryOptions?.debug ?? false,
        prepared.basis,
        prepared.cursorValues,
      );
      return finishPagination(prepared, result);
    });

  const query: TriplesService["query"] = (q: DatalogQuery, queryOptions?: PagedQueryOptions) =>
    validateDatalogQuery(q).pipe(
      Effect.flatMap((validated) =>
        queryPage(wrapDatalogQuery(validated, queryOptions), queryOptions),
      ),
    );

  const explain: TriplesService["explain"] = (q: DatalogQuery) =>
    Effect.gen(function* () {
      if (tieredExecutor !== undefined) {
        return yield* tieredExecutor.explain(q);
      }
      const w = yield* readWatermark;
      const decision = decideTierRoute({
        query: q,
        watermark: w,
        preferAnalyticalCold: options.preferAnalyticalCold,
      });
      options.onRoute?.(decision);
      if (decision.target === "hot") return yield* hot.explain(q);
      return yield* federatedExecutor.explain(q);
    }).pipe(
      Effect.mapError((error) =>
        error instanceof DatalogValidationError || error instanceof UnboundVariableError
          ? error
          : new DatalogError({ message: error.message, cause: error.cause }),
      ),
    );

  const explainPage: TriplesService["explainPage"] = (q: WrappedQuery) =>
    Effect.gen(function* () {
      if (tieredExecutor !== undefined) {
        return yield* tieredExecutor.explainPage(q);
      }
      const w = yield* readWatermark;
      const decision = decideTierRoute({
        query: q.inner,
        watermark: w,
        preferAnalyticalCold: options.preferAnalyticalCold,
      });
      options.onRoute?.(decision);
      if (decision.target === "hot") return yield* hot.explainPage(q);
      return yield* federatedExecutor.explainPage(q);
    }).pipe(
      Effect.mapError((error) =>
        error instanceof DatalogValidationError || error instanceof UnboundVariableError
          ? error
          : new DatalogError({ message: error.message, cause: error.cause }),
      ),
    );

  // ---------------------------------------------------------------------------
  // Sensitive Value Erasure Propagation (§6)
  // ---------------------------------------------------------------------------

  const scrubBlindTokens: TriplesService["scrubBlindTokens"] = hot.scrubBlindTokens
    ? (keyIds: ReadonlyArray<string>): Effect.Effect<number, WriteError> =>
        Effect.gen(function* () {
          const hotCount = yield* hot.scrubBlindTokens!(keyIds);
          yield* recordColdErasedKeys(federatedRunner, keyIds);
          return hotCount;
        })
    : undefined;

  return {
    ...hot,
    ...(scrubBlindTokens === undefined ? {} : { scrubBlindTokens }),
    assertion,
    entity,
    entities,
    match,
    history,
    transaction,
    transactionByCommand,
    transactions,
    transactionsForEntity,
    resolveRecordedBasis,
    queryAll,
    query,
    queryPage,
    explain,
    explainPage,
  } satisfies TriplesService;
};

/**
 * `TieredTriples` decorator namespace.
 *
 * Decorates any `Triples` layer (e.g. `SqliteTriples.layer`) with watermark-aware
 * hot/cold routing and federated DuckDB execution.
 */
export const TieredTriples = {
  layer: (options: TieredTriplesOptions): Layer.Layer<Triples, never, Triples> =>
    Layer.effect(
      Triples,
      Effect.gen(function* () {
        const hot = yield* Triples;
        const runtime = yield* Effect.serviceOption(TripleStoreRuntime);
        return makeTieredTriples(
          hot,
          options,
          Option.isSome(runtime) ? runtime.value.scope : undefined,
          Option.isSome(runtime) ? runtime.value.now : undefined,
        );
      }),
    ),
} as const;
