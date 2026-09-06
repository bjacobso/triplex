import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { EntityId } from "@bjacobso/triplex";
import { SqliteTriples } from "@bjacobso/triplex-sqlite";
import {
  AuthorizationError,
  InMemoryTenantRegistryLive,
  InstanceIdentity,
  StaleRouteError,
  TenantAuthorizer,
  TenantRegistry,
  canTransition,
  canonicalInstanceIdentity,
  executeTenantDataRequest,
  providerInstanceKey,
  resolveAuthorizedPlacement,
  transitionRecord,
  type Principal,
  type TenantRecord,
} from "../src/index.js";

const identity = (tenantId: string, generation = "g1") =>
  Schema.decodeUnknownSync(InstanceIdentity)({
    environment: "test",
    tenantId,
    databaseId: "default",
    generation,
  });

const record = (tenantId: string, state: TenantRecord["state"] = "ready"): TenantRecord => {
  const instance = identity(tenantId);
  return {
    identity: instance,
    placement: { provider: "test", location: "local", instanceKey: providerInstanceKey(instance) },
    state,
    revision: 1,
    routingRevision: 1,
    operationId: "op-1",
    runtimeRelease: "test-release",
    storageSchemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };
};

const AuthorizerLive = Layer.succeed(
  TenantAuthorizer,
  TenantAuthorizer.of({
    authorize: ({ principal, identity: target }) =>
      principal.subject === target.tenantId
        ? Effect.void
        : Effect.fail(new AuthorizationError({ message: "tenant mismatch" })),
  }),
);

describe("host identity and lifecycle", () => {
  it("uses all identity components in canonical scopes and provider keys", () => {
    const first = identity("tenant-a", "g1");
    const recreated = identity("tenant-a", "g2");
    expect(canonicalInstanceIdentity(first)).not.toBe(canonicalInstanceIdentity(recreated));
    expect(providerInstanceKey(first)).toMatch(/^triplex-[0-9a-f]{64}$/);
    expect(providerInstanceKey(first)).not.toBe(providerInstanceKey(recreated));
  });

  it("allows only fenced lifecycle transitions", () => {
    expect(canTransition("provisioning", "ready")).toBe(true);
    expect(canTransition("ready", "deleted")).toBe(false);
    const suspended = transitionRecord(record("tenant-a"), "suspended", "op-2", 2);
    expect(suspended).toMatchObject({ state: "suspended", revision: 2, routingRevision: 2 });
    expect(() => transitionRecord(suspended, "deleted", "op-3", 3)).toThrow("Cannot transition");
  });

  it("compares registry revisions atomically", async () => {
    const initial = record("tenant-a", "provisioning");
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const registry = yield* TenantRegistry;
        yield* registry.compareAndSet(initial, null);
        yield* registry.compareAndSet({ ...initial, revision: 2 }, 0);
      }).pipe(Effect.provide(InMemoryTenantRegistryLive)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("RegistryConflictError");
  });
});

describe("tenant request boundary", () => {
  const tenantA = identity("tenant-a");
  const tenantB = identity("tenant-b");
  const principalA: Principal = { subject: "tenant-a" };

  it("authorizes the bound identity before touching Triples", async () => {
    const exit = await Effect.runPromiseExit(
      executeTenantDataRequest({ identity: tenantB, routingRevision: 1 }, principalA, {
        version: 1,
        identity: tenantB,
        routingRevision: 1,
        operation: { _tag: "Entity", entityId: EntityId.make("tenant-b:secret") },
      }).pipe(
        Effect.provide(AuthorizerLive),
        Effect.provide(SqliteTriples.layerMemoryWithScope(canonicalInstanceIdentity(tenantB))),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("AuthorizationError");
  });

  it("rejects cross-instance identities and stale routing revisions at the target", async () => {
    for (const request of [
      {
        version: 1 as const,
        identity: tenantB,
        routingRevision: 1,
        operation: { _tag: "Entity" as const, entityId: EntityId.make("tenant-a:secret") },
      },
      {
        version: 1 as const,
        identity: tenantA,
        routingRevision: 0,
        operation: { _tag: "Entity" as const, entityId: EntityId.make("tenant-a:secret") },
      },
    ]) {
      const exit = await Effect.runPromiseExit(
        executeTenantDataRequest(
          { identity: tenantA, routingRevision: 1 },
          principalA,
          request,
        ).pipe(
          Effect.provide(AuthorizerLive),
          Effect.provide(SqliteTriples.layerMemoryWithScope(canonicalInstanceIdentity(tenantA))),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(StaleRouteError.name);
    }
  });

  it("never routes suspended instances", async () => {
    const suspended = record("tenant-a", "suspended");
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const registry = yield* TenantRegistry;
        yield* registry.compareAndSet(suspended, null);
        return yield* resolveAuthorizedPlacement(principalA, tenantA, "read");
      }).pipe(Effect.provide(InMemoryTenantRegistryLive), Effect.provide(AuthorizerLive)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(Cause.pretty(exit.cause)).toContain("InstanceUnavailableError");
  });
});
