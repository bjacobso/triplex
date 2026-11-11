import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { EntityId, Triples, KvTriples, type PagedQueryResponse } from "@triplex-build/triplex";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";
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
  decodeTenantDataRequest,
  type DataOperation,
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
  it.each([
    ["KV", KvTriples.layer],
    ["SQLite", SqliteTriples.layerMemory],
  ] as const)(
    "preserves position cuts through decoded %s Query and QueryPage requests",
    async (_backend, backendLayer) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const t = yield* Triples;
          const home = EntityId.make("host:historical");
          const first = yield* t.transact([
            {
              op: "assert",
              entityId: home,
              attribute: ":host/name",
              value: { type: "string", value: "Alice" },
              validFrom: 0,
            },
            {
              op: "assert",
              entityId: EntityId.make("host:bob"),
              attribute: ":host/name",
              value: { type: "string", value: "Bob" },
              validFrom: 0,
            },
          ]);
          yield* t.transact([
            { op: "retract", id: first.triples[0]!.id },
            {
              op: "assert",
              entityId: home,
              attribute: ":host/name",
              value: { type: "string", value: "Alicia" },
              validFrom: 0,
            },
            {
              op: "assert",
              entityId: EntityId.make("host:carol"),
              attribute: ":host/name",
              value: { type: "string", value: "Carol" },
              validFrom: 0,
            },
          ]);
          const target = identity("tenant-a");
          const query = {
            find: ["?name"],
            where: [["?entity", ":host/name", "?name"]] as const,
            orderBy: [{ variable: "?name", direction: "asc" as const }],
          };
          const request = (operation: DataOperation) =>
            Effect.gen(function* () {
              const decoded = yield* decodeTenantDataRequest(
                JSON.parse(
                  JSON.stringify({ version: 1, identity: target, routingRevision: 1, operation }),
                ),
              );
              return yield* executeTenantDataRequest(
                { identity: target, routingRevision: 1 },
                { subject: "tenant-a" },
                decoded,
              );
            });
          const options = { basis: { recordedPosition: first.position, validAt: 1 } };
          expect(yield* request({ _tag: "Query", query, options })).toMatchObject({
            results: [{ "?name": "Alice" }, { "?name": "Bob" }],
          });
          const page = (yield* request({
            _tag: "QueryPage",
            query: { inner: query, limit: 1 },
            options,
          })) as PagedQueryResponse;
          expect(page.results).toEqual([{ "?name": "Alice" }]);
          expect(page.nextCursor).toBeDefined();
          const next = yield* request({
            _tag: "QueryPage",
            query: { inner: query, limit: 1, cursor: page.nextCursor! },
            options,
          });
          expect(next).toMatchObject({ results: [{ "?name": "Bob" }] });
          expect(
            yield* request({
              _tag: "Query",
              query,
              options: { basis: { recordedPosition: 0, validAt: 1 } },
            }),
          ).toMatchObject({ results: [] });
          for (const tag of ["Query", "QueryPage"] as const) {
            const ambiguous = yield* request(
              tag === "Query"
                ? {
                    _tag: tag,
                    query,
                    options: {
                      basis: { recordedAt: Date.now(), recordedPosition: first.position },
                    },
                  }
                : {
                    _tag: tag,
                    query: { inner: query },
                    options: {
                      basis: { recordedAt: Date.now(), recordedPosition: first.position },
                    },
                  },
            ).pipe(Effect.result);
            expect(ambiguous._tag).toBe("Failure");
          }
        }).pipe(Effect.provide(backendLayer), Effect.provide(AuthorizerLive)),
      );
    },
  );
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
