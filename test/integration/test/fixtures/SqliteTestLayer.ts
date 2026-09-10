/**
 * SQLite test layers with acquireRelease lifecycle management.
 *
 * Provides pre-composed Effect layers for testing with in-memory or file-based
 * SQLite. Follows the same acquireRelease pattern as FdbTestLayer and PgTestLayer.
 *
 * Exported layers:
 *
 * - `SqliteTestLayer` — Triples + SQL support (in-memory)
 * - `SqliteFileTestLayer` — Triples + SQL support (file-based, auto-cleanup)
 *
 * Usage with @effect/vitest:
 *
 * ```ts
 * import { layer } from "@effect/vitest"
 * import { SqliteTestLayer } from "../fixtures/SqliteTestLayer.js"
 *
 * layer(SqliteTestLayer)("my tests", (it) => {
 *   it.effect("queries work", () =>
 *     Effect.gen(function* () {
 *       const triples = yield* Triples
 *       // ...
 *     })
 *   )
 * })
 * ```
 *
 * Or for tests that compose additional service layers:
 *
 * ```ts
 * import { SqliteTestLayer } from "../fixtures/SqliteTestLayer.js"
 *
 * const TestLayer = MyServiceLive.pipe(
 *   Layer.provide(SqliteTestLayer),
 * )
 * ```
 */

import { Context, Effect, Layer } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  CurrentDialect,
  RuntimeServicesLive,
  SqliteDialect,
  TriplesLive,
  TripleStoreRuntimeLayer,
} from "@triplex-build/triplex/internal";
import { SqlQueryExecutorLive } from "@triplex-build/triplex-sql";
import { SqliteAdapterLive } from "@triplex-build/triplex-sqlite";

// ─── Pre-composed layers (in-memory, most common) ──────────────────────────

/**
 * Triples and SQL support backed by in-memory SQLite.
 */
export const SqliteTestLayer = TriplesLive.pipe(
  Layer.provideMerge(SqlQueryExecutorLive),
  Layer.provideMerge(SqliteAdapterLive),
  Layer.provideMerge(Layer.succeed(CurrentDialect, SqliteDialect)),
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  Layer.provide(TripleStoreRuntimeLayer),
  Layer.provideMerge(RuntimeServicesLive),
);

// ─── File-based layers (for stress tests / inspection) ─────────────────────

/**
 * Internal context tag carrying the temp directory and DB path.
 * Mirrors FdbTestLayer's FdbClusterFile pattern.
 */
class SqliteDbInfo extends Context.Service<
  SqliteDbInfo,
  { readonly dbPath: string; readonly tmpDir: string }
>()("test/SqliteDbInfo") {}

/**
 * Scoped layer that creates a temp directory on acquire and
 * removes it on release. Provides SqliteDbInfo.
 */
const SqliteFileLifecycleLayer: Layer.Layer<SqliteDbInfo> = Layer.effect(
  SqliteDbInfo,
  Effect.acquireRelease(
    Effect.sync(() => {
      const tmpDir = path.join(
        os.tmpdir(),
        `sqlite-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      );
      fs.mkdirSync(tmpDir, { recursive: true });
      const dbPath = path.join(tmpDir, "test.db");
      return { tmpDir, dbPath };
    }),
    ({ tmpDir }) =>
      Effect.sync(() => {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }),
  ),
);

/**
 * SqliteClient layer that reads the DB path from SqliteDbInfo.
 * Uses Layer.unwrap to dynamically construct the client layer.
 */
const FileSqliteClientLayer = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* SqliteDbInfo;
    return SqliteClient.layer({ filename: dbPath });
  }),
);

/**
 * Composed file-based SqliteClient: lifecycle + client.
 */
const FileSqliteLayer = FileSqliteClientLayer.pipe(Layer.provide(SqliteFileLifecycleLayer));

/**
 * Triples and SQL support backed by file-based SQLite with auto-cleanup.
 *
 * Creates a unique temp directory per layer instantiation. The directory
 * and DB file are removed when the layer scope closes.
 */
export const SqliteFileTestLayer = TriplesLive.pipe(
  Layer.provideMerge(SqlQueryExecutorLive),
  Layer.provideMerge(SqliteAdapterLive),
  Layer.provideMerge(Layer.succeed(CurrentDialect, SqliteDialect)),
  Layer.provide(FileSqliteLayer),
  Layer.provide(TripleStoreRuntimeLayer),
  Layer.provideMerge(RuntimeServicesLive),
);
