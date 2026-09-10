/**
 * FoundationDB subscription watch tests.
 *
 * Requires Docker + FoundationDB client libraries to be available.
 */

import { Deferred, Effect, Ref } from "effect";
import { describe, expect, layer } from "@effect/vitest";
import { createRequire } from "node:module";
import type { QueryDependencies } from "@triplex-build/triplex/subscriptions";
import {
  makeFdbChangeEmitterService,
  makeFdbSubscriptionService,
} from "../src/FdbSubscriptions.js";
import { FdbClusterFile, FdbContainerLayer } from "./fixtures/FdbTestLayer.js";

const require = createRequire(import.meta.url);
const fdbAvailable = (() => {
  try {
    require("foundationdb");
    return true;
  } catch {
    return false;
  }
})();

const describeFdb = fdbAvailable
  ? layer(FdbContainerLayer, { timeout: "60 seconds" })
  : (name: string, _fn: () => void) => describe.skip(name, () => {});

const deps = (overrides: Partial<QueryDependencies>): QueryDependencies => ({
  attributes: new Set(),
  hasDynamicAttributes: false,
  entityTypes: new Set(),
  boundEntityIds: new Set(),
  boundEntityTypes: new Set(),
  unboundEntityTypes: new Set(),
  ruleNames: new Set(),
  ...overrides,
});

describeFdb("FdbSubscriptions", (it) => {
  it.effect("invalidates a watcher when a matching attribute is signaled", () =>
    Effect.gen(function* () {
      const { clusterFilePath } = yield* FdbClusterFile;
      const subspace = Buffer.from(`__watch_${Date.now()}_${Math.random().toString(36).slice(2)}/`);
      const subscriptions = yield* makeFdbSubscriptionService({
        clusterFile: clusterFilePath,
        subspace,
      });
      const invalidated = yield* Deferred.make<void>();

      const handle = yield* subscriptions.watchDependencies(
        deps({
          attributes: new Set([":employee/name"]),
          entityTypes: new Set(["employee"]),
        }),
        () => Deferred.succeed(invalidated, undefined),
        { debounceMs: 5, retryDelayMs: 10 },
      );

      yield* subscriptions.signal({
        txId: "tx-watch-1",
        timestamp: Date.now(),
        changes: [{ operation: "assert", entityId: "emp:alice", attribute: ":employee/name" }],
      });

      yield* Deferred.await(invalidated).pipe(
        Effect.timeoutFail({
          duration: "5 seconds",
          onTimeout: () => new Error("Timed out waiting for FDB watch invalidation"),
        }),
      );
      yield* handle.close();
    }),
  );

  it.effect("does not invalidate attribute watchers for unrelated attributes", () =>
    Effect.gen(function* () {
      const { clusterFilePath } = yield* FdbClusterFile;
      const subspace = Buffer.from(`__watch_${Date.now()}_${Math.random().toString(36).slice(2)}/`);
      const subscriptions = yield* makeFdbSubscriptionService({
        clusterFile: clusterFilePath,
        subspace,
      });
      const count = yield* Ref.make(0);
      const invalidated = yield* Deferred.make<void>();

      const handle = yield* subscriptions.watchDependencies(
        deps({
          attributes: new Set([":employee/name"]),
          entityTypes: new Set(["employee"]),
        }),
        () =>
          Ref.update(count, (n) => n + 1).pipe(
            Effect.andThen(Deferred.succeed(invalidated, undefined)),
          ),
        { debounceMs: 5, retryDelayMs: 10 },
      );

      yield* subscriptions.signal({
        txId: "tx-watch-unrelated",
        timestamp: Date.now(),
        changes: [{ operation: "assert", entityId: "emp:alice", attribute: ":employee/email" }],
      });
      yield* Effect.sleep("100 millis");
      expect(yield* Ref.get(count)).toBe(0);

      yield* subscriptions.signal({
        txId: "tx-watch-related",
        timestamp: Date.now(),
        changes: [{ operation: "assert", entityId: "emp:alice", attribute: ":employee/name" }],
      });
      yield* Deferred.await(invalidated).pipe(
        Effect.timeoutFail({
          duration: "5 seconds",
          onTimeout: () => new Error("Timed out waiting for related FDB watch invalidation"),
        }),
      );
      expect(yield* Ref.get(count)).toBe(1);
      yield* handle.close();
    }),
  );

  it.effect("uses the FDB ChangeEmitter to signal watch keys", () =>
    Effect.gen(function* () {
      const { clusterFilePath } = yield* FdbClusterFile;
      const subspace = Buffer.from(`__watch_${Date.now()}_${Math.random().toString(36).slice(2)}/`);
      const subscriptions = yield* makeFdbSubscriptionService({
        clusterFile: clusterFilePath,
        subspace,
      });
      const emitter = yield* makeFdbChangeEmitterService({
        clusterFile: clusterFilePath,
        subspace,
      });
      const invalidated = yield* Deferred.make<void>();

      const handle = yield* subscriptions.watchDependencies(
        deps({
          hasDynamicAttributes: true,
        }),
        () => Deferred.succeed(invalidated, undefined),
        { debounceMs: 5, retryDelayMs: 10 },
      );

      yield* emitter.emit({
        txId: "tx-change-emitter",
        timestamp: Date.now(),
        changes: [{ operation: "retract", entityId: "task:1", attribute: ":task/status" }],
      });

      yield* Deferred.await(invalidated).pipe(
        Effect.timeoutFail({
          duration: "5 seconds",
          onTimeout: () => new Error("Timed out waiting for ChangeEmitter invalidation"),
        }),
      );
      yield* handle.close();
    }),
  );

  it.effect("isolates watch keys by tenant subspace", () =>
    Effect.gen(function* () {
      const { clusterFilePath } = yield* FdbClusterFile;
      const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const tenantA = yield* makeFdbSubscriptionService({
        clusterFile: clusterFilePath,
        subspace: Buffer.from(`__watch_tenant_a_${suffix}/`),
      });
      const tenantB = yield* makeFdbSubscriptionService({
        clusterFile: clusterFilePath,
        subspace: Buffer.from(`__watch_tenant_b_${suffix}/`),
      });
      const countA = yield* Ref.make(0);
      const countB = yield* Ref.make(0);
      const invalidatedA = yield* Deferred.make<void>();
      const invalidatedB = yield* Deferred.make<void>();
      const dependency = deps({
        attributes: new Set([":employee/name"]),
        entityTypes: new Set(["employee"]),
      });

      const handleA = yield* tenantA.watchDependencies(
        dependency,
        () =>
          Ref.update(countA, (n) => n + 1).pipe(
            Effect.andThen(Deferred.succeed(invalidatedA, undefined)),
            Effect.asVoid,
          ),
        { debounceMs: 5, retryDelayMs: 10 },
      );
      const handleB = yield* tenantB.watchDependencies(
        dependency,
        () =>
          Ref.update(countB, (n) => n + 1).pipe(
            Effect.andThen(Deferred.succeed(invalidatedB, undefined)),
            Effect.asVoid,
          ),
        { debounceMs: 5, retryDelayMs: 10 },
      );

      yield* tenantA.signal({
        txId: "tx-watch-tenant-a",
        timestamp: Date.now(),
        changes: [{ operation: "assert", entityId: "emp:alice", attribute: ":employee/name" }],
      });
      yield* Deferred.await(invalidatedA).pipe(
        Effect.timeoutFail({
          duration: "5 seconds",
          onTimeout: () => new Error("Timed out waiting for tenant A invalidation"),
        }),
      );
      yield* Effect.sleep("100 millis");
      expect(yield* Ref.get(countA)).toBe(1);
      expect(yield* Ref.get(countB)).toBe(0);

      yield* tenantB.signal({
        txId: "tx-watch-tenant-b",
        timestamp: Date.now(),
        changes: [{ operation: "assert", entityId: "emp:alice", attribute: ":employee/name" }],
      });
      yield* Deferred.await(invalidatedB).pipe(
        Effect.timeoutFail({
          duration: "5 seconds",
          onTimeout: () => new Error("Timed out waiting for tenant B invalidation"),
        }),
      );
      expect(yield* Ref.get(countA)).toBe(1);
      expect(yield* Ref.get(countB)).toBe(1);

      yield* handleA.close();
      yield* handleB.close();
    }),
  );
});
