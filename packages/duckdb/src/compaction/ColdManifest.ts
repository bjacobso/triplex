/**
 * Content-addressed cold storage manifest for Triplex.
 *
 * Tracks the durable compaction watermark (`coldWatermarkPosition`), immutable
 * cold Parquet segments for `triples`, `transactions`, and `transaction_entities`,
 * and periodic full live snapshot entries.
 *
 * Every manifest carries a domain-separated SHA-256 `ContentId` over its
 * canonical JSON body (excluding `manifestId` and `updatedAt`), and chains to
 * `previousManifestId` for compare-and-swap publishing.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Data, Effect, Schema } from "effect";
import { CanonicalJson, ContentId } from "@triplex-internal/core/content";

export const COLD_MANIFEST_DOMAIN = "triplex/cold-manifest" as const;
export const COLD_SEGMENT_DOMAIN = "triplex/cold-segment" as const;
export const COLD_SNAPSHOT_DOMAIN = "triplex/cold-snapshot" as const;

export type ColdCompactionErrorCode =
  | "invalid_watermark"
  | "manifest_conflict"
  | "manifest_corrupt"
  | "hot_read_failed"
  | "hot_write_failed"
  | "parquet_write_failed"
  | "snapshot_invalid_position"
  | "journal_reference_violation";

export class ColdCompactionError extends Data.TaggedError("ColdCompactionError")<{
  readonly code: ColdCompactionErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const ColdDatasetKindSchema = Schema.Literals([
  "triples",
  "transactions",
  "transaction_entities",
]);
export type ColdDatasetKind = typeof ColdDatasetKindSchema.Type;

export const ParquetCompressionSchema = Schema.Literals(["zstd", "snappy", "uncompressed"]);
export type ParquetCompression = typeof ParquetCompressionSchema.Type;

const NonNegativeInt = Schema.Number.pipe(
  Schema.check(
    Schema.makeFilter((n) => Number.isInteger(n) && n >= 0, {
      expected: "non-negative integer",
    }),
  ),
);

export const ColdSegmentSchema = Schema.Struct({
  segmentId: Schema.String,
  dataset: ColdDatasetKindSchema,
  path: Schema.String,
  contentId: ContentId.ContentIdSchema,
  minPosition: NonNegativeInt,
  maxPosition: NonNegativeInt,
  rowCount: NonNegativeInt,
  byteSize: NonNegativeInt,
  compression: ParquetCompressionSchema,
  sortOrder: Schema.Array(Schema.String),
});
export type ColdSegment = typeof ColdSegmentSchema.Type;

export const LiveSnapshotEntrySchema = Schema.Struct({
  snapshotId: Schema.String,
  recordedPosition: NonNegativeInt,
  triplesPath: Schema.String,
  contentId: ContentId.ContentIdSchema,
  rowCount: NonNegativeInt,
  byteSize: NonNegativeInt,
  compression: ParquetCompressionSchema,
  createdAt: NonNegativeInt,
});
export type LiveSnapshotEntry = typeof LiveSnapshotEntrySchema.Type;

export const ColdManifestSegmentsSchema = Schema.Struct({
  triples: Schema.Array(ColdSegmentSchema),
  transactions: Schema.Array(ColdSegmentSchema),
  transaction_entities: Schema.Array(ColdSegmentSchema),
});
export type ColdManifestSegments = typeof ColdManifestSegmentsSchema.Type;

export const ColdManifestBodySchema = Schema.Struct({
  formatVersion: Schema.Literal(1),
  databaseScope: Schema.String,
  coldWatermarkPosition: NonNegativeInt,
  previousManifestId: Schema.NullOr(ContentId.ContentIdSchema),
  segments: ColdManifestSegmentsSchema,
  snapshots: Schema.Array(LiveSnapshotEntrySchema),
});
export type ColdManifestBody = typeof ColdManifestBodySchema.Type;

export const ColdManifestSchema = Schema.Struct({
  formatVersion: Schema.Literal(1),
  manifestId: ContentId.ContentIdSchema,
  databaseScope: Schema.String,
  coldWatermarkPosition: NonNegativeInt,
  previousManifestId: Schema.NullOr(ContentId.ContentIdSchema),
  segments: ColdManifestSegmentsSchema,
  snapshots: Schema.Array(LiveSnapshotEntrySchema),
  updatedAt: NonNegativeInt,
});
export type ColdManifest = typeof ColdManifestSchema.Type;

const toCanonicalBody = (body: ColdManifestBody): CanonicalJson.CanonicalValue => ({
  formatVersion: body.formatVersion,
  databaseScope: body.databaseScope,
  coldWatermarkPosition: body.coldWatermarkPosition,
  previousManifestId: body.previousManifestId,
  segments: {
    triples: body.segments.triples.map((s) => ({
      segmentId: s.segmentId,
      dataset: s.dataset,
      path: s.path,
      contentId: s.contentId,
      minPosition: s.minPosition,
      maxPosition: s.maxPosition,
      rowCount: s.rowCount,
      byteSize: s.byteSize,
      compression: s.compression,
      sortOrder: [...s.sortOrder],
    })),
    transactions: body.segments.transactions.map((s) => ({
      segmentId: s.segmentId,
      dataset: s.dataset,
      path: s.path,
      contentId: s.contentId,
      minPosition: s.minPosition,
      maxPosition: s.maxPosition,
      rowCount: s.rowCount,
      byteSize: s.byteSize,
      compression: s.compression,
      sortOrder: [...s.sortOrder],
    })),
    transaction_entities: body.segments.transaction_entities.map((s) => ({
      segmentId: s.segmentId,
      dataset: s.dataset,
      path: s.path,
      contentId: s.contentId,
      minPosition: s.minPosition,
      maxPosition: s.maxPosition,
      rowCount: s.rowCount,
      byteSize: s.byteSize,
      compression: s.compression,
      sortOrder: [...s.sortOrder],
    })),
  },
  snapshots: body.snapshots.map((snap) => ({
    snapshotId: snap.snapshotId,
    recordedPosition: snap.recordedPosition,
    triplesPath: snap.triplesPath,
    contentId: snap.contentId,
    rowCount: snap.rowCount,
    byteSize: snap.byteSize,
    compression: snap.compression,
    createdAt: snap.createdAt,
  })),
});

/** Compute the domain-separated `ContentId` of a manifest body. */
export const computeManifestId = (body: ColdManifestBody): ContentId.ContentId => {
  const canonical = CanonicalJson.encodeOrThrow(toCanonicalBody(body));
  return ContentId.hash(COLD_MANIFEST_DOMAIN, canonical);
};

/**
 * Compute a domain-separated `ContentId` over raw binary bytes (e.g. a Parquet file)
 * using the same `${domain.length}:${domain}:` prefix framing as `ContentId.hash`.
 */
export const computeBytesContentId = (domain: string, bytes: Uint8Array): ContentId.ContentId => {
  const hasher = createHash("sha256");
  hasher.update(`${domain.length}:${domain}:`, "utf8");
  hasher.update(bytes);
  return `sha256-${hasher.digest("hex")}` as ContentId.ContentId;
};

/** Attach `manifestId` and `updatedAt` to a `ColdManifestBody`. */
export const finalizeColdManifest = (
  body: ColdManifestBody,
  updatedAt: number = Date.now(),
): ColdManifest => ({
  ...body,
  manifestId: computeManifestId(body),
  updatedAt: Math.trunc(updatedAt),
});

/** Create an initial empty manifest at watermark 0 for a database scope. */
export const emptyColdManifest = (
  databaseScope: string,
  updatedAt: number = Date.now(),
): ColdManifest =>
  finalizeColdManifest(
    {
      formatVersion: 1,
      databaseScope,
      coldWatermarkPosition: 0,
      previousManifestId: null,
      segments: {
        triples: [],
        transactions: [],
        transaction_entities: [],
      },
      snapshots: [],
    },
    updatedAt,
  );

/** Verify that `manifest.manifestId` matches the canonical hash of its body. */
export const verifyColdManifest = (manifest: ColdManifest): boolean =>
  computeManifestId({
    formatVersion: manifest.formatVersion,
    databaseScope: manifest.databaseScope,
    coldWatermarkPosition: manifest.coldWatermarkPosition,
    previousManifestId: manifest.previousManifestId,
    segments: manifest.segments,
    snapshots: manifest.snapshots,
  }) === manifest.manifestId;

/** Encode a manifest to canonical-order JSON string. */
export const encodeColdManifest = (
  manifest: ColdManifest,
): Effect.Effect<string, ColdCompactionError> =>
  Effect.try({
    try: () => JSON.stringify(manifest, null, 2),
    catch: (cause) =>
      new ColdCompactionError({
        code: "manifest_corrupt",
        message: `Failed to encode cold manifest: ${String(cause)}`,
        cause,
      }),
  });

const decodeManifestSchema = Schema.decodeUnknownSync(ColdManifestSchema);

/** Decode and verify a manifest JSON string. */
export const decodeColdManifest = (
  json: string,
): Effect.Effect<ColdManifest, ColdCompactionError> =>
  Effect.try({
    try: () => {
      const parsed: unknown = JSON.parse(json);
      const manifest = decodeManifestSchema(parsed);
      if (!verifyColdManifest(manifest)) {
        throw new Error(
          `Cold manifest ContentId mismatch: expected ${computeManifestId(manifest)}, got ${manifest.manifestId}`,
        );
      }
      return manifest;
    },
    catch: (cause) =>
      new ColdCompactionError({
        code: "manifest_corrupt",
        message: `Failed to decode cold manifest: ${String(cause)}`,
        cause,
      }),
  });

/** Return all Parquet file paths for a given dataset in the manifest. */
export const segmentPaths = (manifest: ColdManifest, dataset: ColdDatasetKind): readonly string[] =>
  manifest.segments[dataset].map((segment) => segment.path);

/**
 * Atomic compare-and-swap manifest persistence contract.
 *
 * Implementations back onto S3 conditional PUT (`If-Match` / `If-None-Match`),
 * local filesystem temp-file + atomic rename, or in-memory storage for tests.
 */
export interface ColdManifestStore {
  readonly load: Effect.Effect<ColdManifest | null, ColdCompactionError>;
  readonly publish: (
    manifest: ColdManifest,
    expectedPreviousId: ContentId.ContentId | null,
  ) => Effect.Effect<void, ColdCompactionError>;
}

/** In-memory CAS manifest store for tests. */
export const makeInMemoryColdManifestStore = (
  initial: ColdManifest | null = null,
): ColdManifestStore => {
  let current: ColdManifest | null = initial;
  return {
    load: Effect.sync(() => current),
    publish: (manifest, expectedPreviousId) =>
      Effect.suspend(() => {
        const currentId = current?.manifestId ?? null;
        if (currentId !== expectedPreviousId) {
          return Effect.fail(
            new ColdCompactionError({
              code: "manifest_conflict",
              message: `Cold manifest CAS conflict: expected previous ${String(expectedPreviousId)}, found ${String(currentId)}`,
            }),
          );
        }
        if (!verifyColdManifest(manifest)) {
          return Effect.fail(
            new ColdCompactionError({
              code: "manifest_corrupt",
              message: `Refusing to publish manifest with invalid ContentId ${manifest.manifestId}`,
            }),
          );
        }
        current = manifest;
        return Effect.void;
      }),
  };
};

/**
 * Local filesystem CAS manifest store.
 *
 * Writes to a sibling temporary file and atomically renames into `manifestPath`.
 */
export const makeLocalColdManifestStore = (manifestPath: string): ColdManifestStore => {
  const load: Effect.Effect<ColdManifest | null, ColdCompactionError> = Effect.tryPromise({
    try: async () => {
      try {
        return await fs.readFile(manifestPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
    catch: (cause) =>
      new ColdCompactionError({
        code: "manifest_corrupt",
        message: `Failed to read cold manifest at ${manifestPath}: ${String(cause)}`,
        cause,
      }),
  }).pipe(Effect.flatMap((raw) => (raw === null ? Effect.succeed(null) : decodeColdManifest(raw))));

  const publish: ColdManifestStore["publish"] = (manifest, expectedPreviousId) =>
    Effect.gen(function* () {
      if (!verifyColdManifest(manifest)) {
        return yield* new ColdCompactionError({
          code: "manifest_corrupt",
          message: `Refusing to publish manifest with invalid ContentId ${manifest.manifestId}`,
        });
      }
      const existing = yield* load;
      const currentId = existing?.manifestId ?? null;
      if (currentId !== expectedPreviousId) {
        return yield* new ColdCompactionError({
          code: "manifest_conflict",
          message: `Cold manifest CAS conflict at ${manifestPath}: expected previous ${String(expectedPreviousId)}, found ${String(currentId)}`,
        });
      }
      const encoded = yield* encodeColdManifest(manifest);
      const dir = path.dirname(manifestPath);
      const tmpPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
      yield* Effect.tryPromise({
        try: async () => {
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(tmpPath, encoded, "utf8");
          await fs.rename(tmpPath, manifestPath);
        },
        catch: (cause) =>
          new ColdCompactionError({
            code: "manifest_corrupt",
            message: `Failed to atomically publish cold manifest at ${manifestPath}: ${String(cause)}`,
            cause,
          }),
      });
    });

  return { load, publish };
};
