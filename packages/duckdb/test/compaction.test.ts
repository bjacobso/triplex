import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EntityId,
  Triples,
  SqliteDialect,
  decodeJournalChanges,
} from "@triplex-internal/core/internal";
import { ContentId } from "@triplex-internal/core/content";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";
import type { SqlStatementRunner } from "@triplex-build/triplex-sql";
import {
  COLD_SEGMENT_DOMAIN,
  COLD_SNAPSHOT_DOMAIN,
  ColdCompactionError,
  computeBytesContentId,
  computeManifestId,
  decodeColdManifest,
  emptyColdManifest,
  encodeColdManifest,
  finalizeColdManifest,
  makeLocalColdManifestStore,
  makeParquetCompactor,
  readColdWatermark,
  segmentPaths,
  verifyColdManifest,
} from "../src/compaction/index.js";

const strVal = (value: string) => ({ type: "string" as const, value });
const numVal = (value: number) => ({ type: "number" as const, value });

const makeRunner = (sql: SqlClient.SqlClient): SqlStatementRunner => ({
  run: <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[]) =>
    sql.unsafe<Row>(statement, [...params]),
});

const readParquetRows = async <Row extends Record<string, unknown>>(
  filePath: string,
): Promise<readonly Row[]> => {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(
      `SELECT * FROM read_parquet('${filePath.replace(/'/g, "''")}')`,
    );
    return reader.getRowObjects() as unknown as Row[];
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
};

const readParquetCompression = async (filePath: string): Promise<readonly string[]> => {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(
      `SELECT DISTINCT compression FROM parquet_metadata('${filePath.replace(/'/g, "''")}')`,
    );
    return reader.getRowObjects().map((row) => String(row["compression"]));
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
};

describe("ColdManifest", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "triplex-cold-manifest-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("computes deterministic ContentId independent of updatedAt and detects tampering", async () => {
    const m1 = emptyColdManifest("sqlite:test-scope", 1000);
    const m2 = emptyColdManifest("sqlite:test-scope", 2000);
    expect(m1.manifestId).toBe(m2.manifestId);
    expect(ContentId.isContentId(m1.manifestId)).toBe(true);
    expect(verifyColdManifest(m1)).toBe(true);

    const tampered = { ...m1, coldWatermarkPosition: 42 };
    expect(verifyColdManifest(tampered)).toBe(false);

    const encoded = await Effect.runPromise(encodeColdManifest(m1));
    const decoded = await Effect.runPromise(decodeColdManifest(encoded));
    expect(decoded).toEqual(m1);

    const tamperedJson = JSON.stringify(tampered);
    const failed = await Effect.runPromise(Effect.result(decodeColdManifest(tamperedJson)));
    expect(failed._tag).toBe("Failure");
  });

  it("enforces atomic CAS publish in LocalColdManifestStore", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const store = makeLocalColdManifestStore(manifestPath);

    expect(await Effect.runPromise(store.load)).toBeNull();

    const m1 = emptyColdManifest("sqlite:cas", 100);
    await Effect.runPromise(store.publish(m1, null));

    const loaded = await Effect.runPromise(store.load);
    expect(loaded).toEqual(m1);

    const m2 = finalizeColdManifest(
      {
        formatVersion: 1,
        databaseScope: "sqlite:cas",
        coldWatermarkPosition: 5,
        previousManifestId: m1.manifestId,
        segments: m1.segments,
        snapshots: [],
      },
      200,
    );
    expect(computeManifestId(m2)).toBe(m2.manifestId);

    // Stale expectedPreviousId (null instead of m1.manifestId) must fail with manifest_conflict
    const conflict = await Effect.runPromise(Effect.result(store.publish(m2, null)));
    expect(conflict._tag).toBe("Failure");
    if (conflict._tag === "Failure") {
      expect(conflict.failure.code).toBe("manifest_conflict");
    }

    // Correct CAS succeeds
    await Effect.runPromise(store.publish(m2, m1.manifestId));
    expect(await Effect.runPromise(store.load)).toEqual(m2);
  });
});

describe("ParquetCompactor", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "triplex-parquet-compactor-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("archives retracted rows <= W and historical journal rows <= W, leaving live rows and post-W retractions untouched", async () => {
    const scope = "sqlite:compaction-basic";
    const manifestPath = path.join(tmpDir, "manifest.json");
    const manifestStore = makeLocalColdManifestStore(manifestPath);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const sql = yield* SqlClient.SqlClient;
        const runner = makeRunner(sql);

        // Before any compaction, watermark is 0 even without triplex_cold_metadata table
        expect(yield* readColdWatermark(runner, SqliteDialect, scope)).toBe(0);

        // Pos 1: assert e1 name="Alice", e2 name="Bob", e1 age=30
        const tx1 = yield* triples.transact([
          {
            op: "assert",
            entityId: EntityId.make("e1"),
            attribute: ":user/name",
            value: strVal("Alice"),
          },
          {
            op: "assert",
            entityId: EntityId.make("e2"),
            attribute: ":user/name",
            value: strVal("Bob"),
          },
          {
            op: "assert",
            entityId: EntityId.make("e1"),
            attribute: ":user/age",
            value: numVal(30),
          },
        ]);
        const e1NameId = tx1.triples.find(
          (t) => t.entityId === "e1" && t.attribute === ":user/name",
        )!.id;
        const e2NameId = tx1.triples.find(
          (t) => t.entityId === "e2" && t.attribute === ":user/name",
        )!.id;

        // Pos 2: retract e1 name="Alice", assert e1 name="Alicia"
        yield* triples.transact([
          { op: "retract", id: e1NameId },
          {
            op: "assert",
            entityId: EntityId.make("e1"),
            attribute: ":user/name",
            value: strVal("Alicia"),
          },
        ]);

        // Pos 3: retract e2 name="Bob", assert e2 name="Robert"
        yield* triples.transact([
          { op: "retract", id: e2NameId },
          {
            op: "assert",
            entityId: EntityId.make("e2"),
            attribute: ":user/name",
            value: strVal("Robert"),
          },
        ]);

        const compactor = makeParquetCompactor({
          databaseScope: scope,
          hotRunner: runner,
          dialect: SqliteDialect,
          manifestStore,
          outputDir: tmpDir,
          now: () => 1_700_000_000_000,
        });

        // Compact up to W = 2
        const compacted = yield* compactor.compact({
          targetWatermark: 2,
          safeCursorPosition: 2,
        });

        // Watermark persisted in lazily-created table
        const persistedW = yield* compactor.watermark;

        // Check remaining hot triples
        const hotTriples = yield* runner.run<{
          id: string;
          retracted_position: number | null;
        }>("SELECT id, retracted_position FROM triples ORDER BY recorded_position, id", []);

        // Check remaining hot journal rows
        const hotTxs = yield* runner.run<{ position: number; changes: string }>(
          "SELECT position, changes FROM triplex_transactions ORDER BY position",
          [],
        );

        const hotTe = yield* runner.run<{ entity_id: string; position: number }>(
          "SELECT entity_id, position FROM triplex_transaction_entities ORDER BY position, entity_id",
          [],
        );

        return {
          compacted,
          persistedW,
          hotTriples,
          hotTxs,
          hotTe,
          e1NameId,
          e2NameId,
        };
      }).pipe(Effect.provide(SqliteTriples.layerMemoryWithSqlClient)),
    );

    const { compacted, persistedW, hotTriples, hotTxs, hotTe, e1NameId, e2NameId } = result;

    expect(persistedW).toBe(2);
    expect(compacted.previousWatermark).toBe(0);
    expect(compacted.coldWatermarkPosition).toBe(2);
    expect(compacted.recovered).toBe(false);

    // Only e1 name="Alice" was retracted at pos <= 2
    expect(compacted.archivedTriples).toBe(1);
    expect(compacted.deletedTriples).toBe(1);
    // Transactions at pos 1 and pos 2 archived
    expect(compacted.archivedTransactions).toBe(2);
    expect(compacted.deletedTransactions).toBe(2);
    // Transaction entities: pos 1 touched e1 & e2 (2 rows), pos 2 touched e1 (1 row) => 3 rows
    expect(compacted.archivedTransactionEntities).toBe(3);
    expect(compacted.deletedTransactionEntities).toBe(3);

    // Hot triples: e1 name="Alice" deleted; e2 name="Bob" (retracted at pos 3 > W) AND all 3 live rows MUST remain!
    const hotIds = new Set(hotTriples.map((r) => r.id));
    expect(hotIds.has(e1NameId)).toBe(false);
    expect(hotIds.has(e2NameId)).toBe(true);
    expect(hotTriples.length).toBe(4);
    expect(hotTriples.filter((r) => r.retracted_position === null).length).toBe(3);

    // Hot journal: only pos 3 remains
    expect(hotTxs.map((r) => Number(r.position))).toEqual([3]);
    expect(hotTe.map((r) => Number(r.position))).toEqual([3]);

    // Journal reference integrity: every tripleId referenced by retained hot journal rows exists in hot triples!
    for (const tx of hotTxs) {
      for (const [tripleId] of decodeJournalChanges(tx.changes)) {
        expect(hotIds.has(tripleId)).toBe(true);
      }
    }

    // Verify Parquet files on disk: Zstd compression, ContentId match, exact rows and sort order
    const triplePaths = segmentPaths(compacted.manifest, "triples");
    expect(triplePaths.length).toBe(1);
    const parquetTriples = await readParquetRows<{
      id: string;
      attribute: string;
      entity_id: string;
      value_string: string | null;
      retracted_position: bigint | number | null;
    }>(triplePaths[0]!);
    expect(parquetTriples.length).toBe(1);
    expect(parquetTriples[0]!.id).toBe(e1NameId);
    expect(parquetTriples[0]!.value_string).toBe("Alice");
    expect(Number(parquetTriples[0]!.retracted_position)).toBe(2);

    const codecs = await readParquetCompression(triplePaths[0]!);
    expect(codecs.every((c) => c.toUpperCase() === "ZSTD")).toBe(true);

    const fileBytes = await fs.readFile(triplePaths[0]!);
    expect(computeBytesContentId(COLD_SEGMENT_DOMAIN, fileBytes)).toBe(
      compacted.manifest.segments.triples[0]!.contentId,
    );

    const txPaths = segmentPaths(compacted.manifest, "transactions");
    expect(txPaths.length).toBe(1);
    const parquetTxs = await readParquetRows<{ position: bigint | number }>(txPaths[0]!);
    expect(parquetTxs.map((r) => Number(r.position))).toEqual([1, 2]);

    const tePaths = segmentPaths(compacted.manifest, "transaction_entities");
    expect(tePaths.length).toBe(1);
    const parquetTe = await readParquetRows<{ entity_id: string; position: bigint | number }>(
      tePaths[0]!,
    );
    expect(parquetTe.map((r) => [r.entity_id, Number(r.position)])).toEqual([
      ["e1", 1],
      ["e1", 2],
      ["e2", 1],
    ]);
  });

  it("enforces watermark safety bounds (safeCursorPosition and monotonicity)", async () => {
    const scope = "sqlite:watermark-safety";
    const manifestStore = makeLocalColdManifestStore(path.join(tmpDir, "manifest.json"));

    await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const sql = yield* SqlClient.SqlClient;
        const runner = makeRunner(sql);

        const tx1 = yield* triples.transact([
          {
            op: "assert",
            entityId: EntityId.make("e1"),
            attribute: ":a",
            value: strVal("v1"),
          },
        ]);
        yield* triples.transact([{ op: "retract", id: tx1.triples[0]!.id }]);

        const compactor = makeParquetCompactor({
          databaseScope: scope,
          hotRunner: runner,
          dialect: SqliteDialect,
          manifestStore,
          outputDir: tmpDir,
        });

        // Reject targetWatermark > safeCursorPosition
        const overSafe = yield* Effect.result(
          compactor.compact({ targetWatermark: 2, safeCursorPosition: 1 }),
        );
        expect(overSafe._tag).toBe("Failure");
        if (overSafe._tag === "Failure") {
          expect(overSafe.failure.code).toBe("invalid_watermark");
        }

        // Valid compaction to 2
        yield* compactor.compact({ targetWatermark: 2, safeCursorPosition: 2 });

        // Reject backward watermark
        const backward = yield* Effect.result(compactor.compact({ targetWatermark: 1 }));
        expect(backward._tag).toBe("Failure");
        if (backward._tag === "Failure") {
          expect(backward.failure.code).toBe("invalid_watermark");
        }
      }).pipe(Effect.provide(SqliteTriples.layerMemoryWithSqlClient)),
    );
  });

  it("is crash-safe and idempotent across retries at every phase boundary", async () => {
    const scope = "sqlite:crash-recovery";
    const manifestStore = makeLocalColdManifestStore(path.join(tmpDir, "manifest.json"));

    await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const sql = yield* SqlClient.SqlClient;
        const runner = makeRunner(sql);

        // Pos 1..4: two retracted facts (pos 2 and pos 4)
        const tx1 = yield* triples.transact([
          {
            op: "assert",
            entityId: EntityId.make("e1"),
            attribute: ":k",
            value: strVal("v1"),
          },
        ]);
        yield* triples.transact([{ op: "retract", id: tx1.triples[0]!.id }]);
        const tx3 = yield* triples.transact([
          {
            op: "assert",
            entityId: EntityId.make("e2"),
            attribute: ":k",
            value: strVal("v2"),
          },
        ]);
        yield* triples.transact([{ op: "retract", id: tx3.triples[0]!.id }]);

        // 1. Simulate crash right after Parquet write (before manifest publish)
        const crashPhase1 = makeParquetCompactor({
          databaseScope: scope,
          hotRunner: runner,
          dialect: SqliteDialect,
          manifestStore,
          outputDir: tmpDir,
          onPhase: (phase) =>
            phase === "after_parquet_write"
              ? Effect.fail(
                  new ColdCompactionError({
                    code: "parquet_write_failed",
                    message: "simulated crash after parquet write",
                  }),
                )
              : Effect.void,
        });
        const r1 = yield* Effect.result(crashPhase1.compact({ targetWatermark: 2 }));
        expect(r1._tag).toBe("Failure");
        expect(yield* manifestStore.load).toBeNull();
        expect(yield* readColdWatermark(runner, SqliteDialect, scope)).toBe(0);

        // 2. Simulate crash right after manifest publish (before hot watermark update & deletion)
        const crashPhase2 = makeParquetCompactor({
          databaseScope: scope,
          hotRunner: runner,
          dialect: SqliteDialect,
          manifestStore,
          outputDir: tmpDir,
          onPhase: (phase) =>
            phase === "after_manifest_publish"
              ? Effect.fail(
                  new ColdCompactionError({
                    code: "hot_write_failed",
                    message: "simulated crash after manifest publish",
                  }),
                )
              : Effect.void,
        });
        const r2 = yield* Effect.result(crashPhase2.compact({ targetWatermark: 2 }));
        expect(r2._tag).toBe("Failure");
        const publishedManifest = yield* manifestStore.load;
        expect(publishedManifest?.coldWatermarkPosition).toBe(2);
        // Hot watermark not updated yet, hot rows still present
        expect(yield* readColdWatermark(runner, SqliteDialect, scope)).toBe(0);

        // 3. Simulate crash right after hot watermark update (before hot deletion)
        const crashPhase3 = makeParquetCompactor({
          databaseScope: scope,
          hotRunner: runner,
          dialect: SqliteDialect,
          manifestStore,
          outputDir: tmpDir,
          onPhase: (phase) =>
            phase === "after_watermark_update"
              ? Effect.fail(
                  new ColdCompactionError({
                    code: "hot_write_failed",
                    message: "simulated crash after watermark update",
                  }),
                )
              : Effect.void,
        });
        const r3 = yield* Effect.result(crashPhase3.compact({ targetWatermark: 2 }));
        expect(r3._tag).toBe("Failure");
        expect(yield* readColdWatermark(runner, SqliteDialect, scope)).toBe(2);

        // 4. Clean retry completes recovery without duplicating segments
        const cleanCompactor = makeParquetCompactor({
          databaseScope: scope,
          hotRunner: runner,
          dialect: SqliteDialect,
          manifestStore,
          outputDir: tmpDir,
        });
        const recovered = yield* cleanCompactor.compact({ targetWatermark: 2 });
        expect(recovered.recovered).toBe(true);
        expect(recovered.newSegments.length).toBe(0);
        expect(recovered.deletedTriples).toBe(1);
        expect(recovered.deletedTransactions).toBe(2);
        expect(recovered.manifest.manifestId).toBe(publishedManifest!.manifestId);
        expect(recovered.manifest.segments.triples.length).toBe(1);

        // 5. Another retry at W = 2 is a pure idempotent no-op
        const noop = yield* cleanCompactor.compact({ targetWatermark: 2 });
        expect(noop.recovered).toBe(true);
        expect(noop.deletedTriples).toBe(0);
        expect(noop.deletedTransactions).toBe(0);
        expect(noop.manifest.manifestId).toBe(publishedManifest!.manifestId);

        // 6. Advancing to W = 4 appends a second segment cleanly
        const second = yield* cleanCompactor.compact({ targetWatermark: 4 });
        expect(second.recovered).toBe(false);
        expect(second.archivedTriples).toBe(1);
        expect(second.deletedTriples).toBe(1);
        expect(second.manifest.segments.triples.length).toBe(2);
        expect(second.manifest.previousManifestId).toBe(publishedManifest!.manifestId);
      }).pipe(Effect.provide(SqliteTriples.layerMemoryWithSqlClient)),
    );
  });

  it("sorts archived triples by (attribute, entity_id, recorded_position) and exports periodic live snapshots without modifying hot rows", async () => {
    const scope = "sqlite:snapshot-and-sort";
    const manifestStore = makeLocalColdManifestStore(path.join(tmpDir, "manifest.json"));

    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const sql = yield* SqlClient.SqlClient;
        const runner = makeRunner(sql);

        // Assert out-of-order attributes/entities across multiple commits
        const tx1 = yield* triples.transact([
          {
            op: "assert",
            entityId: EntityId.make("e2"),
            attribute: ":z/attr",
            value: strVal("z2"),
          },
          {
            op: "assert",
            entityId: EntityId.make("e1"),
            attribute: ":a/attr",
            value: strVal("a1"),
          },
        ]);
        yield* triples.transact([
          {
            op: "assert",
            entityId: EntityId.make("e1"),
            attribute: ":z/attr",
            value: strVal("z1"),
          },
          {
            op: "assert",
            entityId: EntityId.make("e2"),
            attribute: ":a/attr",
            value: strVal("a2"),
          },
        ]);
        // Retract tx1 rows at pos 3
        yield* triples.transact([
          { op: "retract", id: tx1.triples[0]!.id },
          { op: "retract", id: tx1.triples[1]!.id },
        ]);
        // Pos 4: assert another live fact
        yield* triples.transact([
          {
            op: "assert",
            entityId: EntityId.make("e3"),
            attribute: ":m/attr",
            value: numVal(42),
          },
        ]);

        const compactor = makeParquetCompactor({
          databaseScope: scope,
          hotRunner: runner,
          dialect: SqliteDialect,
          manifestStore,
          outputDir: tmpDir,
        });

        // Compact W = 3 (archives the 2 retracted triples from tx1)
        const compacted = yield* compactor.compact({ targetWatermark: 3 });

        // Reject live snapshot below W = 3
        const belowW = yield* Effect.result(compactor.exportLiveSnapshot({ recordedPosition: 2 }));
        expect(belowW._tag).toBe("Failure");
        if (belowW._tag === "Failure") {
          expect(belowW.failure.code).toBe("snapshot_invalid_position");
        }

        // Export live snapshot at P = 3 (should contain the 2 rows from tx2, NOT tx1 retracted at 3, NOT tx4 asserted at 4)
        const snapAt3 = yield* compactor.exportLiveSnapshot({ recordedPosition: 3 });
        // Export live snapshot at P = 4 (should contain tx2 + tx4 = 3 rows)
        const snapAt4 = yield* compactor.exportLiveSnapshot({ recordedPosition: 4 });

        // Hot table must still contain all 3 live rows untouched
        const hotCount = yield* runner.run<{ total: number }>(
          "SELECT COUNT(*) AS total FROM triples",
          [],
        );

        return {
          compacted,
          snapAt3,
          snapAt4,
          hotCount: Number(hotCount[0]?.total ?? 0),
        };
      }).pipe(Effect.provide(SqliteTriples.layerMemoryWithSqlClient)),
    );

    expect(out.hotCount).toBe(3);

    // Verify archived triples sort order: (attribute, entity_id, recorded_position)
    const archivedRows = await readParquetRows<{
      attribute: string;
      entity_id: string;
      recorded_position: bigint | number;
    }>(out.compacted.manifest.segments.triples[0]!.path);
    expect(
      archivedRows.map((r) => [r.attribute, r.entity_id, Number(r.recorded_position)]),
    ).toEqual([
      [":a/attr", "e1", 1],
      [":z/attr", "e2", 1],
    ]);

    // Verify snapshot at P = 3
    expect(out.snapAt3.snapshot.recordedPosition).toBe(3);
    expect(out.snapAt3.snapshot.rowCount).toBe(2);
    const snap3Rows = await readParquetRows<{
      attribute: string;
      entity_id: string;
      recorded_position: bigint | number;
    }>(out.snapAt3.snapshot.triplesPath);
    expect(snap3Rows.map((r) => [r.attribute, r.entity_id, Number(r.recorded_position)])).toEqual([
      [":a/attr", "e2", 2],
      [":z/attr", "e1", 2],
    ]);
    const snap3Bytes = await fs.readFile(out.snapAt3.snapshot.triplesPath);
    expect(computeBytesContentId(COLD_SNAPSHOT_DOMAIN, snap3Bytes)).toBe(
      out.snapAt3.snapshot.contentId,
    );

    // Verify snapshot at P = 4
    expect(out.snapAt4.snapshot.recordedPosition).toBe(4);
    expect(out.snapAt4.snapshot.rowCount).toBe(3);
    expect(out.snapAt4.manifest.snapshots.length).toBe(2);
    const snap4Rows = await readParquetRows<{
      attribute: string;
      entity_id: string;
      recorded_position: bigint | number;
    }>(out.snapAt4.snapshot.triplesPath);
    expect(snap4Rows.map((r) => [r.attribute, r.entity_id, Number(r.recorded_position)])).toEqual([
      [":a/attr", "e2", 2],
      [":m/attr", "e3", 4],
      [":z/attr", "e1", 2],
    ]);
  });

  it("never deletes a retracted fact if referenced by a retained hot journal row and preserves value_sealed/value_blind in Parquet", async () => {
    const scope = "sqlite:journal-ref-and-sealed";
    const manifestStore = makeLocalColdManifestStore(path.join(tmpDir, "manifest.json"));

    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const sql = yield* SqlClient.SqlClient;
        const runner = makeRunner(sql);

        // Pos 1: assert two facts (one normal, one sealed)
        const tx1 = yield* triples.transact([
          {
            op: "assert",
            entityId: EntityId.make("e1"),
            attribute: ":secret/ssn",
            value: {
              type: "sealed",
              valueType: "string",
              keyId: "key-1",
              ciphertext: "enc_payload_abc",
              blind: "blind_token_xyz",
            },
          },
          {
            op: "assert",
            entityId: EntityId.make("e2"),
            attribute: ":note",
            value: strVal("protected"),
          },
        ]);
        const sealedId = tx1.triples.find((t) => t.attribute === ":secret/ssn")!.id;
        const protectedId = tx1.triples.find((t) => t.attribute === ":note")!.id;

        // Pos 2: retract both
        yield* triples.transact([
          { op: "retract", id: sealedId },
          { op: "retract", id: protectedId },
        ]);

        // Pos 3: commit a later transaction and inject a cross-watermark journal reference
        // to `protectedId` to verify defensive journal-reference protection.
        const tx3 = yield* triples.transact([
          {
            op: "assert",
            entityId: EntityId.make("e3"),
            attribute: ":ok",
            value: strVal("yes"),
          },
        ]);
        yield* runner.run("UPDATE triplex_transactions SET changes = ? WHERE tx_id = ?", [
          JSON.stringify([
            [tx3.triples[0]!.id, "assert"],
            [protectedId, "retract"],
          ]),
          tx3.txId,
        ]);

        const compactor = makeParquetCompactor({
          databaseScope: scope,
          hotRunner: runner,
          dialect: SqliteDialect,
          manifestStore,
          outputDir: tmpDir,
        });

        const compacted = yield* compactor.compact({ targetWatermark: 2 });
        const hotIdsAfterW2 = (yield* runner.run<{ id: string }>("SELECT id FROM triples", [])).map(
          (r) => r.id,
        );

        // Advance watermark to W = 3 so pos 3 journal row is archived too;
        // previously deferred `protectedId` must be archived to Parquet BEFORE deletion.
        const compactedW3 = yield* compactor.compact({ targetWatermark: 3 });
        const hotIdsAfterW3 = (yield* runner.run<{ id: string }>("SELECT id FROM triples", [])).map(
          (r) => r.id,
        );

        return {
          compacted,
          compactedW3,
          hotIdsAfterW2,
          hotIdsAfterW3,
          sealedId,
          protectedId,
        };
      }).pipe(Effect.provide(SqliteTriples.layerMemoryWithSqlClient)),
    );

    // At W = 2: `protectedId` MUST remain in hot because pos 3 journal row still references it
    expect(out.hotIdsAfterW2).toContain(out.protectedId);
    // `sealedId` was safely archived and deleted from hot
    expect(out.hotIdsAfterW2).not.toContain(out.sealedId);
    expect(out.compacted.archivedTriples).toBe(1);
    expect(out.compacted.deletedTriples).toBe(1);

    // At W = 3: previously deferred `protectedId` is archived into the new segment and then deleted
    expect(out.compactedW3.archivedTriples).toBe(1);
    expect(out.compactedW3.deletedTriples).toBe(1);
    expect(out.hotIdsAfterW3).not.toContain(out.protectedId);
    expect(out.compactedW3.manifest.segments.triples.length).toBe(2);
    const archivedW3 = await readParquetRows<{ id: string }>(
      out.compactedW3.manifest.segments.triples[1]!.path,
    );
    expect(archivedW3.map((r) => r.id)).toEqual([out.protectedId]);
    expect(out.compactedW3.manifest.segments.triples[1]!.minPosition).toBe(2);

    const archived = await readParquetRows<{
      id: string;
      value_type: string;
      value_string: string | null;
      value_sealed: string | null;
      value_blind: string | null;
    }>(out.compacted.manifest.segments.triples[0]!.path);
    expect(archived.length).toBe(1);
    expect(archived[0]!.id).toBe(out.sealedId);
    expect(archived[0]!.value_type).toBe("sealed");
    expect(archived[0]!.value_string).toBeNull();
    expect(archived[0]!.value_sealed).toBe(
      JSON.stringify({
        valueType: "string",
        keyId: "key-1",
        ciphertext: "enc_payload_abc",
      }),
    );
    expect(archived[0]!.value_blind).toBe("blind_token_xyz");
  });

  it("propagates non-missing-table errors in readColdWatermark instead of swallowing them as 0", async () => {
    const failingRunner: SqlStatementRunner = {
      run: () => Effect.fail(new Error("permission denied for relation triplex_cold_metadata")),
    };

    const result = await Effect.runPromise(
      Effect.result(readColdWatermark(failingRunner, SqliteDialect, "sqlite:err")),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.code).toBe("hot_read_failed");
    }
  });

  it("emits PostgreSQL-compatible $N parameter placeholders when configured with postgresql dialect", async () => {
    const scope = "pg:compat-check";
    const manifestStore = makeLocalColdManifestStore(path.join(tmpDir, "pg-manifest.json"));
    const statements: string[] = [];

    const pgDialect = {
      name: "postgresql" as const,
      limitOffset: (limit: number | undefined, offset: number | undefined) =>
        `${limit !== undefined ? `LIMIT ${limit}` : ""}${offset !== undefined ? ` OFFSET ${offset}` : ""}`,
      castAsText: (expr: string) => `CAST(${expr} AS TEXT)`,
      booleanLiteral: (v: boolean) => (v ? "TRUE" : "FALSE"),
      paramPlaceholder: (index: number) => `$${index}`,
      escapeLikePattern: (v: string) => v,
    };

    const mockRunner: SqlStatementRunner = {
      run: <Row extends Record<string, unknown>>(statement: string) => {
        statements.push(statement);
        if (statement.includes("COUNT(*)")) {
          return Effect.succeed([{ total: 0 }] as unknown as readonly Row[]);
        }
        return Effect.succeed([] as readonly Row[]);
      },
    };

    const compactor = makeParquetCompactor({
      databaseScope: scope,
      hotRunner: mockRunner,
      dialect: pgDialect,
      manifestStore,
      outputDir: tmpDir,
    });

    const result = await Effect.runPromise(compactor.compact({ targetWatermark: 10 }));

    expect(result.coldWatermarkPosition).toBe(10);
    // Every parameterized statement must use $1..$N placeholders, never `?`
    const parameterized = statements.filter((s) => s.includes("$1"));
    expect(parameterized.length).toBeGreaterThan(0);
    for (const stmt of statements) {
      expect(stmt).not.toContain("?");
    }
  });
});
