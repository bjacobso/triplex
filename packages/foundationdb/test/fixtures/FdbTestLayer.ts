/**
 * Testcontainers-based FoundationDB test layer.
 *
 * Spins up a FoundationDB Docker container, initializes the database,
 * writes a host-accessible cluster file, and provides a KvBackend layer
 * scoped to a unique subspace for test isolation.
 *
 * All heavy dependencies (testcontainers, foundationdb) are loaded lazily
 * inside Effect — the module can be imported without those packages installed.
 */

import { Context, Effect, Layer } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { KvBackend } from "@triplex-build/triplex";
import { makeFdbKvBackendService, type FdbKvBackendConfig } from "../../src/FdbKvBackend.js";

// ─── Constants ─────────────────────────────────────────────────────────────

const FDB_IMAGE = process.env["FDB_TEST_IMAGE"] ?? "foundationdb/foundationdb:7.3.75";
const FDB_PLATFORM =
  process.env["FDB_TEST_PLATFORM"] ?? (process.arch === "arm64" ? "linux/arm64" : "linux/amd64");
const FDB_PORT = 4500;
const FDB_STARTUP_TIMEOUT_MS = 60_000;

// ─── Container lifecycle ───────────────────────────────────────────────────

/**
 * Start a FoundationDB container, initialize the database, and return
 * the cluster file path that the host-side client can use.
 *
 * testcontainers is imported dynamically so this module doesn't blow up
 * at import time when the package isn't installed.
 */
const acquireFdbContainer = Effect.gen(function* () {
  const { GenericContainer, Wait } = yield* Effect.promise(() => import("testcontainers"));

  yield* Effect.logInfo("Starting FoundationDB container...");

  const container = yield* Effect.tryPromise({
    try: () =>
      new GenericContainer(FDB_IMAGE)
        .withPlatform(FDB_PLATFORM)
        .withStartupTimeout(FDB_STARTUP_TIMEOUT_MS)
        .withWaitStrategy(Wait.forLogMessage(/FDBD joined cluster/))
        .start(),
    catch: (e) => new Error(`Failed to start FDB container: ${String(e)}`),
  }).pipe(Effect.orDie);

  const networkName = container.getNetworkNames()[0];
  if (!networkName) {
    throw new Error("FDB container has no attached networks");
  }
  const containerIp = container.getIpAddress(networkName);

  yield* Effect.logInfo(`FDB container started at ${containerIp}:${FDB_PORT}`);

  // Initialize the database (required for fresh FDB instances)
  yield* Effect.tryPromise({
    try: () => container.exec(["fdbcli", "--exec", "configure new single memory"]),
    catch: (e) => new Error(`Failed to initialize FDB: ${String(e)}`),
  }).pipe(Effect.orDie);

  // Wait briefly for the database to become available
  yield* Effect.tryPromise({
    try: async () => {
      for (let i = 0; i < 10; i++) {
        const result = await container.exec(["fdbcli", "--exec", "status minimal"]);
        if (result.output.includes("database is available")) return;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error("FDB database did not become available within 5 seconds");
    },
    catch: (e) => new Error(`FDB health check failed: ${String(e)}`),
  }).pipe(Effect.orDie);

  yield* Effect.logInfo("FDB database initialized and available");

  // Write a cluster file pointing directly at the container IP + canonical port.
  const clusterFileContent = `docker:docker@${containerIp}:${FDB_PORT}`;
  const clusterFilePath = path.join(
    os.tmpdir(),
    `fdb-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.cluster`,
  );
  fs.writeFileSync(clusterFilePath, clusterFileContent);

  yield* Effect.logInfo(`Cluster file: ${clusterFilePath} → ${clusterFileContent}`);

  return { container, clusterFilePath };
});

const releaseFdbContainer = ({
  container,
  clusterFilePath,
}: {
  container: { stop: () => Promise<void> };
  clusterFilePath: string;
}) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("Stopping FDB container...");
    yield* Effect.tryPromise({
      try: () => container.stop(),
      catch: (e) => new Error(`Failed to stop FDB container: ${String(e)}`),
    }).pipe(Effect.orDie);

    try {
      fs.unlinkSync(clusterFilePath);
    } catch {
      // ignore
    }

    yield* Effect.logInfo("FDB container stopped");
  });

// ─── Reusable FDB context tag ──────────────────────────────────────────────

export class FdbClusterFile extends Context.Service<
  FdbClusterFile,
  { readonly clusterFilePath: string }
>()("test/FdbClusterFile") {}

// ─── Layers ────────────────────────────────────────────────────────────────

export const FdbContainerLayer: Layer.Layer<FdbClusterFile> = Layer.effect(
  FdbClusterFile,
  Effect.acquireRelease(acquireFdbContainer, releaseFdbContainer).pipe(
    Effect.map(({ clusterFilePath }) => ({ clusterFilePath })),
  ),
);

const FdbKvBackendLayer: Layer.Layer<KvBackend, never, FdbClusterFile> = Layer.effect(
  KvBackend,
  Effect.gen(function* () {
    const { clusterFilePath } = yield* FdbClusterFile;

    const subspace = Buffer.from(`__test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}/`);

    const config: FdbKvBackendConfig = {
      clusterFile: clusterFilePath,
      subspace,
      maxTransactionBytes: 16_384,
      rangeScanPageSize: 128,
    };

    const kv = yield* makeFdbKvBackendService(config);

    yield* kv.get(new Uint8Array([0])).pipe(
      Effect.timeoutFail({
        duration: "5 seconds",
        onTimeout: () =>
          new Error(
            `FDB connectivity probe timed out (clusterFile=${clusterFilePath}). ` +
              "This often means Docker networking cannot reach the container IP.",
          ),
      }),
    );

    return kv;
  }),
);

/**
 * Complete test layer: FDB container + KvBackend.
 *
 * testcontainers and foundationdb are loaded lazily inside the layer —
 * importing this module is safe even when those packages aren't installed.
 * Tests that use this layer will fail at layer acquisition time (not import time)
 * if the dependencies are missing, which @effect/vitest handles gracefully.
 */
export const FdbTestLayer: Layer.Layer<KvBackend> = FdbKvBackendLayer.pipe(
  Layer.provide(FdbContainerLayer),
);
