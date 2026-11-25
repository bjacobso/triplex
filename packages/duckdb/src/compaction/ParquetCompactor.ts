/**
 * Watermark-bounded Parquet compaction and live snapshot export for Triplex.
 *
 * Implements §3, §4, and §5 (snapshot export) of `docs/rfcs/cold-tier-duckdb.md`:
 *
 * - Archives strictly immutable retracted facts (`retracted_position IS NOT NULL
 *   AND retracted_position <= W`) plus historical journal rows (`position <= W`)
 *   into Zstd-compressed Parquet files sorted by `(attribute, entity_id, recorded_position)`,
 *   `(position)`, and `(entity_id, position)`.
 * - Preserves live rows (`retracted_position IS NULL`) and rows retracted after `W`
 *   in the hot store.
 * - Preserves the journal `[tripleId, op]` change-reference invariant: never deletes
 *   a fact still referenced by any retained hot journal row (`position > W`).
 * - Two-phase crash-safe publish:
 *   1. Write immutable Parquet segments + compute domain-separated `ContentId`.
 *   2. Atomically CAS-publish `ColdManifest` + update durable `cold_watermark_position`
 *      in the lazily-created `triplex_cold_metadata` table.
 *   3. Delete compacted rows from the hot store in batches (idempotent on retry).
 * - Exports periodic full live snapshots at `recorded_position = P` to Parquet
 *   without modifying hot rows.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { Effect } from "effect";
import {
  createParamCollector,
  decodeJournalChanges,
  generateId,
  type SqlDialect,
  type TripleRow,
} from "@triplex-internal/core/internal";
import type { ContentId } from "@triplex-internal/core/content";
import type { SqlStatementRunner } from "@triplex-build/triplex-sql";
import {
  COLD_SEGMENT_DOMAIN,
  COLD_SNAPSHOT_DOMAIN,
  ColdCompactionError,
  computeBytesContentId,
  emptyColdManifest,
  finalizeColdManifest,
  type ColdDatasetKind,
  type ColdManifest,
  type ColdManifestStore,
  type ColdSegment,
  type LiveSnapshotEntry,
  type ParquetCompression,
} from "./ColdManifest.js";

// =============================================================================
// Lazily-created hot metadata table
// =============================================================================

/**
 * Metadata table tracking each database scope's durable compaction watermark.
 * Created lazily by the compactor so `packages/sql/src/schema.ts` baseline
 * migrations remain untouched.
 */
export const COLD_METADATA_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS triplex_cold_metadata (
    database_scope TEXT PRIMARY KEY NOT NULL,
    cold_watermark_position BIGINT NOT NULL,
    manifest_id TEXT,
    updated_at BIGINT NOT NULL
  )
`;

const collectErrorMessages = (error: unknown, depth = 0): string => {
  if (error === null || error === undefined || depth > 5) return "";
  const parts = [String(error)];
  if (typeof error === "object") {
    const rec = error as Record<string, unknown>;
    if (typeof rec["message"] === "string") parts.push(rec["message"]);
    if (rec["cause"] !== undefined) parts.push(collectErrorMessages(rec["cause"], depth + 1));
    if (rec["reason"] !== undefined) parts.push(collectErrorMessages(rec["reason"], depth + 1));
  }
  return parts.join(" ");
};

const isMissingTableError = (error: unknown): boolean => {
  const msg = collectErrorMessages(error).toLowerCase();
  return (
    msg.includes("no such table") ||
    msg.includes("does not exist") ||
    msg.includes("42p01") ||
    msg.includes("undefined_table")
  );
};

/**
 * Read the durable `cold_watermark_position` from the hot database.
 * Returns `0` if the lazily-created metadata table or scope row does not exist yet.
 */
export const readColdWatermark = (
  hotRunner: SqlStatementRunner,
  dialect: SqlDialect,
  databaseScope: string,
): Effect.Effect<number, ColdCompactionError> => {
  const p = createParamCollector(dialect);
  return hotRunner
    .run<{ readonly cold_watermark_position: number | string | bigint }>(
      `SELECT cold_watermark_position FROM triplex_cold_metadata WHERE database_scope = ${p.add(databaseScope)}`,
      p.params,
    )
    .pipe(
      Effect.map((rows) => {
        const raw = rows[0]?.cold_watermark_position;
        return raw === undefined || raw === null ? 0 : Number(raw);
      }),
      Effect.catch((cause) =>
        isMissingTableError(cause)
          ? Effect.succeed(0)
          : Effect.fail(
              new ColdCompactionError({
                code: "hot_read_failed",
                message: `Failed to read cold_watermark_position: ${String(cause)}`,
                cause,
              }),
            ),
      ),
    );
};

/**
 * Ensure `triplex_cold_metadata` exists and upsert the durable watermark for `databaseScope`.
 */
export const writeColdWatermark = (
  hotRunner: SqlStatementRunner,
  dialect: SqlDialect,
  databaseScope: string,
  watermark: number,
  manifestId: ContentId.ContentId | null,
  updatedAt: number = Date.now(),
): Effect.Effect<void, ColdCompactionError> =>
  Effect.gen(function* () {
    yield* hotRunner.run(COLD_METADATA_TABLE_DDL, []);
    const p = createParamCollector(dialect);
    yield* hotRunner.run(
      `INSERT INTO triplex_cold_metadata (database_scope, cold_watermark_position, manifest_id, updated_at)
       VALUES (${p.add(databaseScope)}, ${p.add(watermark)}, ${p.add(manifestId)}, ${p.add(Math.trunc(updatedAt))})
       ON CONFLICT (database_scope) DO UPDATE SET
         cold_watermark_position = excluded.cold_watermark_position,
         manifest_id = excluded.manifest_id,
         updated_at = excluded.updated_at`,
      p.params,
    );
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ColdCompactionError({
          code: "hot_write_failed",
          message: `Failed to update cold_watermark_position to ${watermark}: ${String(cause)}`,
          cause,
        }),
    ),
  );

// =============================================================================
// Types & Configuration
// =============================================================================

export type CompactionPhase =
  | "after_parquet_write"
  | "after_manifest_publish"
  | "after_watermark_update";

export interface ParquetCompactorConfig {
  readonly databaseScope: string;
  readonly hotRunner: SqlStatementRunner;
  readonly dialect: SqlDialect;
  readonly manifestStore: ColdManifestStore;
  /** Base local directory where cold Parquet segments and snapshots are written. */
  readonly outputDir: string;
  /** Parquet compression codec. Defaults to `"zstd"`. */
  readonly compression?: ParquetCompression;
  /** Parquet row group size. Defaults to 122,880. */
  readonly rowGroupSize?: number;
  /** Max rows deleted per hot DELETE batch. Defaults to 1,000. */
  readonly deleteBatchSize?: number;
  /** Optional clock override for deterministic timestamps. */
  readonly now?: () => number;
  /** Optional phase boundary hook (for observability or crash-recovery testing). */
  readonly onPhase?: (phase: CompactionPhase) => Effect.Effect<void, ColdCompactionError>;
}

export interface CompactOptions {
  /** Target compaction watermark `W_next` (inclusive). */
  readonly targetWatermark: number;
  /**
   * Optional upper bound safe for compaction (older than active pagination cursors
   * and pinned checkpoints). If provided, `targetWatermark` must be `<= safeCursorPosition`.
   */
  readonly safeCursorPosition?: number;
}

export interface CompactResult {
  readonly databaseScope: string;
  readonly previousWatermark: number;
  readonly coldWatermarkPosition: number;
  readonly manifest: ColdManifest;
  readonly archivedTriples: number;
  readonly archivedTransactions: number;
  readonly archivedTransactionEntities: number;
  readonly deletedTriples: number;
  readonly deletedTransactions: number;
  readonly deletedTransactionEntities: number;
  readonly newSegments: readonly ColdSegment[];
  /** True when resuming/completing an already-published watermark without re-exporting. */
  readonly recovered: boolean;
}

export interface ExportSnapshotOptions {
  /** Exact `recorded_position = P` at which to export live facts. Must be `>= coldWatermarkPosition`. */
  readonly recordedPosition: number;
}

export interface ExportSnapshotResult {
  readonly databaseScope: string;
  readonly snapshot: LiveSnapshotEntry;
  readonly manifest: ColdManifest;
}

export interface ParquetCompactorService {
  readonly watermark: Effect.Effect<number, ColdCompactionError>;
  readonly loadManifest: Effect.Effect<ColdManifest | null, ColdCompactionError>;
  readonly compact: (options: CompactOptions) => Effect.Effect<CompactResult, ColdCompactionError>;
  readonly exportLiveSnapshot: (
    options: ExportSnapshotOptions,
  ) => Effect.Effect<ExportSnapshotResult, ColdCompactionError>;
}

// =============================================================================
// Row shapes & column lists
// =============================================================================

type HotTransactionRow = {
  readonly tx_id: string;
  readonly position: number | string | bigint;
  readonly instant: number | string | bigint;
  readonly actor: string | null;
  readonly command_id: string | null;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly config_snapshot: string | null;
  readonly changes: string;
};

type HotTransactionEntityRow = {
  readonly entity_id: string;
  readonly position: number | string | bigint;
  readonly tx_id: string;
};

const TRIPLE_COLUMNS = [
  "id",
  "entity_id",
  "attribute",
  "value_type",
  "value_string",
  "value_number",
  "value_boolean",
  "value_datetime",
  "value_json",
  "recorded_at",
  "recorded_position",
  "valid_from",
  "valid_to",
  "created_by",
  "retracted_at",
  "retracted_position",
  "retract_tx_id",
  "entity_type",
  "schema_version",
  "tx_id",
  "value_sealed",
  "value_blind",
] as const;

const TRANSACTION_COLUMNS = [
  "tx_id",
  "position",
  "instant",
  "actor",
  "command_id",
  "correlation_id",
  "causation_id",
  "config_snapshot",
  "changes",
] as const;

const TRANSACTION_ENTITY_COLUMNS = ["entity_id", "position", "tx_id"] as const;

const TRIPLE_SORT_ORDER = ["attribute", "entity_id", "recorded_position"] as const;
const TRANSACTION_SORT_ORDER = ["position"] as const;
const TRANSACTION_ENTITY_SORT_ORDER = ["entity_id", "position"] as const;

const sanitizeScope = (scope: string): string =>
  scope.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+/, "") || "default";

const positionBucket = (watermark: number): number => Math.floor(watermark / 100_000) * 100_000;

const escapeSqlLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const toNullableString = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

const toNullableNumber = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return Number(v);
};

const toNullableBigInt = (v: unknown): bigint | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v;
  return BigInt(Math.trunc(Number(v)));
};

const toNullableInt = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  return Math.trunc(Number(v));
};

// =============================================================================
// DuckDB Parquet Writer
// =============================================================================

const writeParquetViaDuckDb = async (
  targetPath: string,
  compression: ParquetCompression,
  rowGroupSize: number,
  tableDdl: string,
  insertSql: string,
  rows: readonly (readonly (string | number | bigint | null)[])[],
  selectSql: string,
): Promise<{ readonly byteSize: number; readonly contentId: ContentId.ContentId }> => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp.parquet`;
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run(tableDdl);
    if (rows.length > 0) {
      const prepared = await connection.prepare(insertSql);
      try {
        for (const values of rows) {
          prepared.clearBindings();
          for (let i = 0; i < values.length; i++) {
            const val = values[i];
            const idx = i + 1;
            if (val === null) {
              prepared.bindNull(idx);
            } else if (typeof val === "string") {
              prepared.bindVarchar(idx, val);
            } else if (typeof val === "bigint") {
              prepared.bindBigInt(idx, val);
            } else if (typeof val === "number") {
              prepared.bindDouble(idx, val);
            }
          }
          await prepared.run();
        }
      } finally {
        prepared.destroySync();
      }
    }
    const copySql = `COPY (${selectSql}) TO ${escapeSqlLiteral(tmpPath)} (FORMAT PARQUET, COMPRESSION ${escapeSqlLiteral(compression)}, ROW_GROUP_SIZE ${Math.trunc(rowGroupSize)})`;
    await connection.run(copySql);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }

  await fs.rename(tmpPath, targetPath);
  const bytes = await fs.readFile(targetPath);
  return {
    byteSize: bytes.byteLength,
    contentId: computeBytesContentId(COLD_SEGMENT_DOMAIN, bytes),
  };
};

const writeTriplesParquet = (
  rows: readonly TripleRow[],
  targetPath: string,
  compression: ParquetCompression,
  rowGroupSize: number,
  domain: string,
): Effect.Effect<
  { readonly byteSize: number; readonly contentId: ContentId.ContentId },
  ColdCompactionError
> =>
  Effect.tryPromise({
    try: async () => {
      const tableDdl = `
        CREATE TABLE _stage_triples (
          id VARCHAR NOT NULL,
          entity_id VARCHAR NOT NULL,
          attribute VARCHAR NOT NULL,
          value_type VARCHAR NOT NULL,
          value_string VARCHAR,
          value_number DOUBLE,
          value_boolean INTEGER,
          value_datetime BIGINT,
          value_json VARCHAR,
          recorded_at BIGINT NOT NULL,
          recorded_position BIGINT NOT NULL,
          valid_from BIGINT NOT NULL,
          valid_to BIGINT,
          created_by VARCHAR,
          retracted_at BIGINT,
          retracted_position BIGINT,
          retract_tx_id VARCHAR,
          entity_type VARCHAR,
          schema_version INTEGER,
          tx_id VARCHAR,
          value_sealed VARCHAR,
          value_blind VARCHAR
        )
      `;
      const placeholders = TRIPLE_COLUMNS.map((_, idx) => `$${idx + 1}`).join(", ");
      const insertSql = `INSERT INTO _stage_triples (${TRIPLE_COLUMNS.join(", ")}) VALUES (${placeholders})`;
      const tuples = rows.map((row) => [
        String(row.id),
        String(row.entity_id),
        String(row.attribute),
        String(row.value_type),
        toNullableString(row.value_string),
        toNullableNumber(row.value_number),
        toNullableInt(row.value_boolean),
        toNullableBigInt(row.value_datetime),
        toNullableString(row.value_json),
        toNullableBigInt(row.recorded_at)!,
        toNullableBigInt(row.recorded_position)!,
        toNullableBigInt(row.valid_from)!,
        toNullableBigInt(row.valid_to),
        toNullableString(row.created_by),
        toNullableBigInt(row.retracted_at),
        toNullableBigInt(row.retracted_position),
        toNullableString(row.retract_tx_id),
        toNullableString(row.entity_type),
        toNullableInt(row.schema_version),
        toNullableString(row.tx_id),
        toNullableString(row.value_sealed),
        toNullableString(row.value_blind),
      ]);
      const selectSql = `SELECT ${TRIPLE_COLUMNS.join(", ")} FROM _stage_triples ORDER BY attribute, entity_id, recorded_position`;
      const res = await writeParquetViaDuckDb(
        targetPath,
        compression,
        rowGroupSize,
        tableDdl,
        insertSql,
        tuples,
        selectSql,
      );
      if (domain !== COLD_SEGMENT_DOMAIN) {
        const bytes = await fs.readFile(targetPath);
        return {
          byteSize: res.byteSize,
          contentId: computeBytesContentId(domain, bytes),
        };
      }
      return res;
    },
    catch: (cause) =>
      new ColdCompactionError({
        code: "parquet_write_failed",
        message: `Failed to write triples Parquet file ${targetPath}: ${String(cause)}`,
        cause,
      }),
  });

const writeTransactionsParquet = (
  rows: readonly HotTransactionRow[],
  targetPath: string,
  compression: ParquetCompression,
  rowGroupSize: number,
): Effect.Effect<
  { readonly byteSize: number; readonly contentId: ContentId.ContentId },
  ColdCompactionError
> =>
  Effect.tryPromise({
    try: async () => {
      const tableDdl = `
        CREATE TABLE _stage_transactions (
          tx_id VARCHAR NOT NULL,
          position BIGINT NOT NULL,
          instant BIGINT NOT NULL,
          actor VARCHAR,
          command_id VARCHAR,
          correlation_id VARCHAR,
          causation_id VARCHAR,
          config_snapshot VARCHAR,
          changes VARCHAR NOT NULL
        )
      `;
      const placeholders = TRANSACTION_COLUMNS.map((_, idx) => `$${idx + 1}`).join(", ");
      const insertSql = `INSERT INTO _stage_transactions (${TRANSACTION_COLUMNS.join(", ")}) VALUES (${placeholders})`;
      const tuples = rows.map((row) => [
        String(row.tx_id),
        toNullableBigInt(row.position)!,
        toNullableBigInt(row.instant)!,
        toNullableString(row.actor),
        toNullableString(row.command_id),
        toNullableString(row.correlation_id),
        toNullableString(row.causation_id),
        toNullableString(row.config_snapshot),
        String(row.changes),
      ]);
      const selectSql = `SELECT ${TRANSACTION_COLUMNS.join(", ")} FROM _stage_transactions ORDER BY position`;
      return writeParquetViaDuckDb(
        targetPath,
        compression,
        rowGroupSize,
        tableDdl,
        insertSql,
        tuples,
        selectSql,
      );
    },
    catch: (cause) =>
      new ColdCompactionError({
        code: "parquet_write_failed",
        message: `Failed to write transactions Parquet file ${targetPath}: ${String(cause)}`,
        cause,
      }),
  });

const writeTransactionEntitiesParquet = (
  rows: readonly HotTransactionEntityRow[],
  targetPath: string,
  compression: ParquetCompression,
  rowGroupSize: number,
): Effect.Effect<
  { readonly byteSize: number; readonly contentId: ContentId.ContentId },
  ColdCompactionError
> =>
  Effect.tryPromise({
    try: async () => {
      const tableDdl = `
        CREATE TABLE _stage_transaction_entities (
          entity_id VARCHAR NOT NULL,
          position BIGINT NOT NULL,
          tx_id VARCHAR NOT NULL
        )
      `;
      const placeholders = TRANSACTION_ENTITY_COLUMNS.map((_, idx) => `$${idx + 1}`).join(", ");
      const insertSql = `INSERT INTO _stage_transaction_entities (${TRANSACTION_ENTITY_COLUMNS.join(", ")}) VALUES (${placeholders})`;
      const tuples = rows.map((row) => [
        String(row.entity_id),
        toNullableBigInt(row.position)!,
        String(row.tx_id),
      ]);
      const selectSql = `SELECT ${TRANSACTION_ENTITY_COLUMNS.join(", ")} FROM _stage_transaction_entities ORDER BY entity_id, position`;
      return writeParquetViaDuckDb(
        targetPath,
        compression,
        rowGroupSize,
        tableDdl,
        insertSql,
        tuples,
        selectSql,
      );
    },
    catch: (cause) =>
      new ColdCompactionError({
        code: "parquet_write_failed",
        message: `Failed to write transaction_entities Parquet file ${targetPath}: ${String(cause)}`,
        cause,
      }),
  });

// =============================================================================
// Hot Store Helpers
// =============================================================================

/**
 * Collect every tripleId referenced by any retained hot journal row (`position > watermark`).
 * Enforces the journal `[tripleId, op]` change-reference invariant defensively so
 * compaction can never delete a fact still referenced by a retained hot journal row.
 */
const collectHotReferencedTripleIds = (
  hotRunner: SqlStatementRunner,
  dialect: SqlDialect,
  watermark: number,
): Effect.Effect<ReadonlySet<string>, ColdCompactionError> => {
  const p = createParamCollector(dialect);
  return hotRunner
    .run<{ readonly changes: string }>(
      `SELECT changes FROM triplex_transactions WHERE position > ${p.add(watermark)}`,
      p.params,
    )
    .pipe(
      Effect.flatMap((rows) =>
        Effect.try({
          try: () => {
            const ids = new Set<string>();
            for (const row of rows) {
              const refs = decodeJournalChanges(row.changes);
              for (const [tripleId] of refs) {
                ids.add(tripleId);
              }
            }
            return ids as ReadonlySet<string>;
          },
          catch: (cause) =>
            new ColdCompactionError({
              code: "journal_reference_violation",
              message: `Failed to decode retained hot journal change references: ${String(cause)}`,
              cause,
            }),
        }),
      ),
      Effect.mapError((cause) =>
        cause instanceof ColdCompactionError
          ? cause
          : new ColdCompactionError({
              code: "hot_read_failed",
              message: `Failed to read retained hot journal rows: ${String(cause)}`,
              cause,
            }),
      ),
    );
};

const deleteCompactedHotRows = (
  hotRunner: SqlStatementRunner,
  dialect: SqlDialect,
  watermark: number,
  deleteBatchSize: number,
): Effect.Effect<
  {
    readonly deletedTriples: number;
    readonly deletedTransactions: number;
    readonly deletedTransactionEntities: number;
  },
  ColdCompactionError
> =>
  Effect.gen(function* () {
    // 1. Collect triple IDs referenced by retained hot journal rows (`position > W`).
    const protectedIds = yield* collectHotReferencedTripleIds(hotRunner, dialect, watermark);

    // 2. Find candidate triple IDs with `retracted_position IS NOT NULL AND retracted_position <= W`.
    const tp = createParamCollector(dialect);
    const candidateTriples = yield* hotRunner
      .run<{ readonly id: string }>(
        `SELECT id FROM triples WHERE retracted_position IS NOT NULL AND retracted_position <= ${tp.add(watermark)}`,
        tp.params,
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ColdCompactionError({
              code: "hot_read_failed",
              message: `Failed to scan compacted triple IDs for deletion: ${String(cause)}`,
              cause,
            }),
        ),
      );

    // Never delete any triple still referenced by a retained hot journal row.
    const deletableTripleIds = candidateTriples
      .map((r) => r.id)
      .filter((id) => !protectedIds.has(id));

    for (let i = 0; i < deletableTripleIds.length; i += deleteBatchSize) {
      const batch = deletableTripleIds.slice(i, i + deleteBatchSize);
      const dp = createParamCollector(dialect);
      const placeholders = batch.map((id) => dp.add(id)).join(", ");
      yield* hotRunner.run(`DELETE FROM triples WHERE id IN (${placeholders})`, dp.params).pipe(
        Effect.mapError(
          (cause) =>
            new ColdCompactionError({
              code: "hot_write_failed",
              message: `Failed to delete compacted triples batch: ${String(cause)}`,
              cause,
            }),
        ),
      );
    }

    // 3. Delete archived `triplex_transaction_entities` with `position <= W`.
    const tepCountP = createParamCollector(dialect);
    const teCountRows = yield* hotRunner
      .run<{ readonly total: number | string | bigint }>(
        `SELECT COUNT(*) AS total FROM triplex_transaction_entities WHERE position <= ${tepCountP.add(watermark)}`,
        tepCountP.params,
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ColdCompactionError({
              code: "hot_read_failed",
              message: `Failed to count compacted transaction_entities: ${String(cause)}`,
              cause,
            }),
        ),
      );
    const deletedTransactionEntities = Number(teCountRows[0]?.total ?? 0);
    if (deletedTransactionEntities > 0) {
      const tepDelP = createParamCollector(dialect);
      yield* hotRunner
        .run(
          `DELETE FROM triplex_transaction_entities WHERE position <= ${tepDelP.add(watermark)}`,
          tepDelP.params,
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ColdCompactionError({
                code: "hot_write_failed",
                message: `Failed to delete compacted transaction_entities: ${String(cause)}`,
                cause,
              }),
          ),
        );
    }

    // 4. Delete archived `triplex_transactions` with `position <= W`.
    const txCountP = createParamCollector(dialect);
    const txCountRows = yield* hotRunner
      .run<{ readonly total: number | string | bigint }>(
        `SELECT COUNT(*) AS total FROM triplex_transactions WHERE position <= ${txCountP.add(watermark)}`,
        txCountP.params,
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ColdCompactionError({
              code: "hot_read_failed",
              message: `Failed to count compacted transactions: ${String(cause)}`,
              cause,
            }),
        ),
      );
    const deletedTransactions = Number(txCountRows[0]?.total ?? 0);
    if (deletedTransactions > 0) {
      const txDelP = createParamCollector(dialect);
      yield* hotRunner
        .run(
          `DELETE FROM triplex_transactions WHERE position <= ${txDelP.add(watermark)}`,
          txDelP.params,
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ColdCompactionError({
                code: "hot_write_failed",
                message: `Failed to delete compacted transactions: ${String(cause)}`,
                cause,
              }),
          ),
        );
    }

    return {
      deletedTriples: deletableTripleIds.length,
      deletedTransactions,
      deletedTransactionEntities,
    };
  });

// =============================================================================
// ParquetCompactor Implementation
// =============================================================================

export const makeParquetCompactor = (config: ParquetCompactorConfig): ParquetCompactorService => {
  const compression: ParquetCompression = config.compression ?? "zstd";
  const rowGroupSize = config.rowGroupSize ?? 122_880;
  const deleteBatchSize = Math.max(1, config.deleteBatchSize ?? 1_000);
  const now = config.now ?? (() => Date.now());
  const scopeDir = sanitizeScope(config.databaseScope);

  const segmentFilePath = (dataset: ColdDatasetKind, watermark: number, segmentId: string) =>
    path.join(
      config.outputDir,
      scopeDir,
      "cold",
      dataset,
      `bucket=${positionBucket(watermark)}`,
      `part-${segmentId}.parquet`,
    );

  const snapshotFilePath = (recordedPosition: number, snapshotId: string) =>
    path.join(
      config.outputDir,
      scopeDir,
      "snapshots",
      `pos=${recordedPosition}`,
      `triples-${snapshotId}.parquet`,
    );

  const watermark: Effect.Effect<number, ColdCompactionError> = readColdWatermark(
    config.hotRunner,
    config.dialect,
    config.databaseScope,
  );

  const loadManifest: Effect.Effect<ColdManifest | null, ColdCompactionError> =
    config.manifestStore.load;

  const compact: ParquetCompactorService["compact"] = (options) =>
    Effect.gen(function* () {
      const { targetWatermark, safeCursorPosition } = options;
      if (!Number.isInteger(targetWatermark) || targetWatermark < 0) {
        return yield* new ColdCompactionError({
          code: "invalid_watermark",
          message: `targetWatermark must be a non-negative integer, got ${String(targetWatermark)}`,
        });
      }
      if (safeCursorPosition !== undefined) {
        if (!Number.isInteger(safeCursorPosition) || safeCursorPosition < 0) {
          return yield* new ColdCompactionError({
            code: "invalid_watermark",
            message: `safeCursorPosition must be a non-negative integer, got ${String(safeCursorPosition)}`,
          });
        }
        if (targetWatermark > safeCursorPosition) {
          return yield* new ColdCompactionError({
            code: "invalid_watermark",
            message: `targetWatermark (${targetWatermark}) exceeds safeCursorPosition (${safeCursorPosition})`,
          });
        }
      }

      const existingManifest = yield* config.manifestStore.load;
      if (existingManifest !== null && existingManifest.databaseScope !== config.databaseScope) {
        return yield* new ColdCompactionError({
          code: "manifest_corrupt",
          message: `Manifest scope mismatch: expected ${config.databaseScope}, found ${existingManifest.databaseScope}`,
        });
      }

      const hotWatermark = yield* watermark;
      const manifestWatermark = existingManifest?.coldWatermarkPosition ?? 0;

      if (targetWatermark < Math.max(hotWatermark, manifestWatermark)) {
        return yield* new ColdCompactionError({
          code: "invalid_watermark",
          message: `Compaction watermark cannot move backward: target ${targetWatermark} < current ${Math.max(hotWatermark, manifestWatermark)}`,
        });
      }

      // Crash-recovery / idempotent retry path:
      // If the manifest has already advanced to `targetWatermark`, do not re-export
      // segments; instead ensure the hot watermark is synced and delete any leftover
      // hot rows <= targetWatermark.
      if (existingManifest !== null && manifestWatermark === targetWatermark) {
        if (hotWatermark < manifestWatermark) {
          yield* writeColdWatermark(
            config.hotRunner,
            config.dialect,
            config.databaseScope,
            manifestWatermark,
            existingManifest.manifestId,
            now(),
          );
          if (config.onPhase) {
            yield* config.onPhase("after_watermark_update");
          }
        }
        const deleted = yield* deleteCompactedHotRows(
          config.hotRunner,
          config.dialect,
          manifestWatermark,
          deleteBatchSize,
        );
        return {
          databaseScope: config.databaseScope,
          previousWatermark: hotWatermark,
          coldWatermarkPosition: manifestWatermark,
          manifest: existingManifest,
          archivedTriples: 0,
          archivedTransactions: 0,
          archivedTransactionEntities: 0,
          deletedTriples: deleted.deletedTriples,
          deletedTransactions: deleted.deletedTransactions,
          deletedTransactionEntities: deleted.deletedTransactionEntities,
          newSegments: [],
          recovered: true,
        };
      }

      const previousWatermark = manifestWatermark;
      const baseManifest = existingManifest ?? emptyColdManifest(config.databaseScope, now());
      const expectedPreviousId = existingManifest?.manifestId ?? null;

      // -----------------------------------------------------------------------
      // Phase 1: Export immutable rows in (previousWatermark, targetWatermark]
      //          to Zstd-compressed Parquet files and compute ContentIds.
      // -----------------------------------------------------------------------
      const protectedIds = yield* collectHotReferencedTripleIds(
        config.hotRunner,
        config.dialect,
        targetWatermark,
      );

      // Query all retracted triples <= targetWatermark still present in hot.
      // Using `<= targetWatermark` (rather than `> previousWatermark`) guarantees
      // that any triple deferred at an earlier watermark due to a retained hot
      // journal reference is archived once that reference ages out, before Phase 3
      // deletes it from hot.
      const triplesP = createParamCollector(config.dialect);
      const rawTriples = yield* config.hotRunner
        .run<TripleRow>(
          `SELECT ${TRIPLE_COLUMNS.join(", ")} FROM triples
           WHERE retracted_position IS NOT NULL
             AND retracted_position <= ${triplesP.add(targetWatermark)}
           ORDER BY attribute, entity_id, recorded_position`,
          triplesP.params,
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ColdCompactionError({
                code: "hot_read_failed",
                message: `Failed to query retracted triples for compaction: ${String(cause)}`,
                cause,
              }),
          ),
        );

      // Defensively exclude any triple still referenced by a retained hot journal row.
      const eligibleTriples = rawTriples.filter((row) => !protectedIds.has(row.id));

      const txP = createParamCollector(config.dialect);
      const eligibleTransactions = yield* config.hotRunner
        .run<HotTransactionRow>(
          `SELECT ${TRANSACTION_COLUMNS.join(", ")} FROM triplex_transactions
           WHERE position > ${txP.add(previousWatermark)}
             AND position <= ${txP.add(targetWatermark)}
           ORDER BY position`,
          txP.params,
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ColdCompactionError({
                code: "hot_read_failed",
                message: `Failed to query transactions for compaction: ${String(cause)}`,
                cause,
              }),
          ),
        );

      const teP = createParamCollector(config.dialect);
      const eligibleTransactionEntities = yield* config.hotRunner
        .run<HotTransactionEntityRow>(
          `SELECT ${TRANSACTION_ENTITY_COLUMNS.join(", ")} FROM triplex_transaction_entities
           WHERE position > ${teP.add(previousWatermark)}
             AND position <= ${teP.add(targetWatermark)}
           ORDER BY entity_id, position`,
          teP.params,
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ColdCompactionError({
                code: "hot_read_failed",
                message: `Failed to query transaction_entities for compaction: ${String(cause)}`,
                cause,
              }),
          ),
        );

      const newTripleSegments: ColdSegment[] = [];
      const newTxSegments: ColdSegment[] = [];
      const newTeSegments: ColdSegment[] = [];
      const minPos = previousWatermark + 1;

      if (eligibleTriples.length > 0) {
        const segmentId = generateId();
        const filePath = segmentFilePath("triples", targetWatermark, segmentId);
        const written = yield* writeTriplesParquet(
          eligibleTriples,
          filePath,
          compression,
          rowGroupSize,
          COLD_SEGMENT_DOMAIN,
        );
        const tripleMinPos = eligibleTriples.reduce(
          (acc, row) => Math.min(acc, Number(row.retracted_position ?? acc)),
          minPos,
        );
        newTripleSegments.push({
          segmentId,
          dataset: "triples",
          path: filePath,
          contentId: written.contentId,
          minPosition: tripleMinPos,
          maxPosition: targetWatermark,
          rowCount: eligibleTriples.length,
          byteSize: written.byteSize,
          compression,
          sortOrder: [...TRIPLE_SORT_ORDER],
        });
      }

      if (eligibleTransactions.length > 0) {
        const segmentId = generateId();
        const filePath = segmentFilePath("transactions", targetWatermark, segmentId);
        const written = yield* writeTransactionsParquet(
          eligibleTransactions,
          filePath,
          compression,
          rowGroupSize,
        );
        newTxSegments.push({
          segmentId,
          dataset: "transactions",
          path: filePath,
          contentId: written.contentId,
          minPosition: minPos,
          maxPosition: targetWatermark,
          rowCount: eligibleTransactions.length,
          byteSize: written.byteSize,
          compression,
          sortOrder: [...TRANSACTION_SORT_ORDER],
        });
      }

      if (eligibleTransactionEntities.length > 0) {
        const segmentId = generateId();
        const filePath = segmentFilePath("transaction_entities", targetWatermark, segmentId);
        const written = yield* writeTransactionEntitiesParquet(
          eligibleTransactionEntities,
          filePath,
          compression,
          rowGroupSize,
        );
        newTeSegments.push({
          segmentId,
          dataset: "transaction_entities",
          path: filePath,
          contentId: written.contentId,
          minPosition: minPos,
          maxPosition: targetWatermark,
          rowCount: eligibleTransactionEntities.length,
          byteSize: written.byteSize,
          compression,
          sortOrder: [...TRANSACTION_ENTITY_SORT_ORDER],
        });
      }

      if (config.onPhase) {
        yield* config.onPhase("after_parquet_write");
      }

      // -----------------------------------------------------------------------
      // Phase 2: Atomically publish new ColdManifest, then persist hot watermark.
      // -----------------------------------------------------------------------
      const ts = now();
      const nextManifest = finalizeColdManifest(
        {
          formatVersion: 1,
          databaseScope: config.databaseScope,
          coldWatermarkPosition: targetWatermark,
          previousManifestId: expectedPreviousId,
          segments: {
            triples: [...baseManifest.segments.triples, ...newTripleSegments],
            transactions: [...baseManifest.segments.transactions, ...newTxSegments],
            transaction_entities: [...baseManifest.segments.transaction_entities, ...newTeSegments],
          },
          snapshots: [...baseManifest.snapshots],
        },
        ts,
      );

      yield* config.manifestStore.publish(nextManifest, expectedPreviousId);

      if (config.onPhase) {
        yield* config.onPhase("after_manifest_publish");
      }

      yield* writeColdWatermark(
        config.hotRunner,
        config.dialect,
        config.databaseScope,
        targetWatermark,
        nextManifest.manifestId,
        ts,
      );

      if (config.onPhase) {
        yield* config.onPhase("after_watermark_update");
      }

      // -----------------------------------------------------------------------
      // Phase 3: Delete compacted rows from hot store.
      // -----------------------------------------------------------------------
      const deleted = yield* deleteCompactedHotRows(
        config.hotRunner,
        config.dialect,
        targetWatermark,
        deleteBatchSize,
      );

      return {
        databaseScope: config.databaseScope,
        previousWatermark,
        coldWatermarkPosition: targetWatermark,
        manifest: nextManifest,
        archivedTriples: eligibleTriples.length,
        archivedTransactions: eligibleTransactions.length,
        archivedTransactionEntities: eligibleTransactionEntities.length,
        deletedTriples: deleted.deletedTriples,
        deletedTransactions: deleted.deletedTransactions,
        deletedTransactionEntities: deleted.deletedTransactionEntities,
        newSegments: [...newTripleSegments, ...newTxSegments, ...newTeSegments],
        recovered: false,
      };
    });

  const exportLiveSnapshot: ParquetCompactorService["exportLiveSnapshot"] = (options) =>
    Effect.gen(function* () {
      const { recordedPosition } = options;
      if (!Number.isInteger(recordedPosition) || recordedPosition < 0) {
        return yield* new ColdCompactionError({
          code: "snapshot_invalid_position",
          message: `recordedPosition must be a non-negative integer, got ${String(recordedPosition)}`,
        });
      }

      const existingManifest = yield* config.manifestStore.load;
      const hotWatermark = yield* watermark;
      const currentWatermark = Math.max(hotWatermark, existingManifest?.coldWatermarkPosition ?? 0);

      if (recordedPosition < currentWatermark) {
        return yield* new ColdCompactionError({
          code: "snapshot_invalid_position",
          message: `Cannot export hot live snapshot at recordedPosition ${recordedPosition} below cold watermark ${currentWatermark}`,
        });
      }

      // Every fact live at P >= W is guaranteed to be in hot:
      // recorded_position <= P AND (retracted_position IS NULL OR retracted_position > P).
      const p = createParamCollector(config.dialect);
      const liveRows = yield* config.hotRunner
        .run<TripleRow>(
          `SELECT ${TRIPLE_COLUMNS.join(", ")} FROM triples
           WHERE recorded_position <= ${p.add(recordedPosition)}
             AND (retracted_position IS NULL OR retracted_position > ${p.add(recordedPosition)})
           ORDER BY attribute, entity_id, recorded_position`,
          p.params,
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ColdCompactionError({
                code: "hot_read_failed",
                message: `Failed to query live triples for snapshot at position ${recordedPosition}: ${String(cause)}`,
                cause,
              }),
          ),
        );

      const snapshotId = generateId();
      const targetPath = snapshotFilePath(recordedPosition, snapshotId);
      const written = yield* writeTriplesParquet(
        liveRows,
        targetPath,
        compression,
        rowGroupSize,
        COLD_SNAPSHOT_DOMAIN,
      );

      const ts = now();
      const snapshotEntry: LiveSnapshotEntry = {
        snapshotId,
        recordedPosition,
        triplesPath: targetPath,
        contentId: written.contentId,
        rowCount: liveRows.length,
        byteSize: written.byteSize,
        compression,
        createdAt: ts,
      };

      const baseManifest = existingManifest ?? emptyColdManifest(config.databaseScope, ts);
      const expectedPreviousId = existingManifest?.manifestId ?? null;
      const nextManifest = finalizeColdManifest(
        {
          formatVersion: 1,
          databaseScope: config.databaseScope,
          coldWatermarkPosition: baseManifest.coldWatermarkPosition,
          previousManifestId: expectedPreviousId,
          segments: baseManifest.segments,
          snapshots: [...baseManifest.snapshots, snapshotEntry],
        },
        ts,
      );

      yield* config.manifestStore.publish(nextManifest, expectedPreviousId);

      return {
        databaseScope: config.databaseScope,
        snapshot: snapshotEntry,
        manifest: nextManifest,
      };
    });

  return {
    watermark,
    loadManifest,
    compact,
    exportLiveSnapshot,
  };
};
