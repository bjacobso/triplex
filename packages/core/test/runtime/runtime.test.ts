import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import { EntityId, Triples, number } from "../../src/index.js";
import {
  Runtime,
  DatabaseScope,
  Capabilities,
  changeEmission,
  type ChangeEvent,
  KvBackend,
  StorageAdapter,
  QueryExecutor,
  MigrationError,
} from "../../src/runtime/index.js";
import { makeTestKvBackend } from "../../src/kv/kv/InMemoryKvBackend.js";

const definition = () =>
  Runtime.fromKv({
    name: "memory",
    backend: Layer.sync(KvBackend, makeTestKvBackend),
  });
const scope = DatabaseScope.test("runtime");

describe("public runtime composition", () => {
  it("encodes complete identities without delimiter collisions", () => {
    const identity = { env: "prod", tenant: "a:b", database: "c", generation: 0 };
    const encoded = DatabaseScope.make(identity);
    expect(encoded).toBe(DatabaseScope.make({ ...identity }));
    expect(encoded).not.toBe(DatabaseScope.make({ ...identity, tenant: "a", database: "b:c" }));
    expect(encoded).not.toBe(DatabaseScope.make({ ...identity, generation: 1 }));
    expect(() => DatabaseScope.make({ ...identity, tenant: " " })).toThrow();
    for (const generation of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => DatabaseScope.make({ ...identity, generation })).toThrow();
    }
    expect(() =>
      definition().layer({ scope: "default" as DatabaseScope, capabilities: Capabilities.none }),
    ).toThrow("Invalid DatabaseScope");
  });

  it("restarts deterministic IDs for each build and uses the supplied clock", async () => {
    const runtime = definition();
    const database = runtime.layer({
      scope,
      capabilities: Capabilities.none,
      deterministic: { startTime: 42, seed: "repeat" },
    });
    const write = Effect.gen(function* () {
      const triples = yield* Triples;
      return yield* triples.assert({
        entityId: EntityId.make("runtime:one"),
        attribute: ":runtime/value",
        value: number(1),
      });
    }).pipe(Effect.provide(database));
    const first = await Effect.runPromise(write);
    const second = await Effect.runPromise(write);
    expect(first.id).toBe(second.id);
    expect(first.txId).toEqual(second.txId);
    expect(first.recordedAt).toBe(42);
  });

  it("rejects cursors from a different database identity", async () => {
    const runtime = definition();
    const query = { find: ["?e"], where: [["?e", ":runtime/value", "?v"]] } as const;
    const cursor = await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        yield* triples.assertBatch(
          [1, 2].map((v) => ({
            entityId: EntityId.make(`runtime:${v}`),
            attribute: ":runtime/value",
            value: number(v),
          })),
        );
        return (yield* triples.query(query, { pageSize: 1 })).nextCursor!;
      }).pipe(Effect.provide(runtime.layer({ scope, capabilities: Capabilities.none }))),
    );
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        return yield* triples.query(query, { pageSize: 1, cursor }).pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          runtime.layer({
            scope: DatabaseScope.test("other"),
            capabilities: Capabilities.none,
          }),
        ),
      ),
    );
    expect(error._tag).toBe("PaginationCursorError");
  });

  it("emits committed changes with the runtime clock and rejects duplicate capabilities", async () => {
    const events: ChangeEvent[] = [];
    const emission = changeEmission({
      emit: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
    });
    const runtime = definition();
    await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        yield* triples.transact([
          {
            op: "assert",
            entityId: EntityId.make("runtime:one"),
            attribute: ":runtime/value",
            value: number(1),
          },
        ]);
      }).pipe(
        Effect.provide(
          runtime.layer({
            scope,
            capabilities: Capabilities.of(emission),
            deterministic: { startTime: 42, seed: "emit" },
          }),
        ),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.timestamp).toBe(42);
    expect(events[0]?.changes).toContainEqual({
      operation: "assert",
      entityId: "runtime:one",
      attribute: ":runtime/value",
    });
    const error = await Effect.runPromise(
      Triples.pipe(
        Effect.provide(
          runtime.layer({
            scope,
            capabilities: Capabilities.of(emission, emission),
          }),
        ),
        Effect.flip,
      ),
    );
    expect(error._tag).toBe("CapabilityError");
    expect(error.message).toContain("Duplicate capability");
  });

  it("keeps unexpected custom-wrapper exceptions in the defect channel", async () => {
    const exit = await Effect.runPromiseExit(
      Triples.pipe(
        Effect.provide(
          definition().layer({
            scope,
            capabilities: Capabilities.custom({
              name: "broken",
              priority: 1,
              requires: [],
              wrap: () => {
                throw new Error("wrapper bug");
              },
            }),
          }),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.hasFails(exit.cause)).toBe(false);
    }
  });

  it("releases adapter-owned resources on success and capability failure", async () => {
    let opened = 0;
    let closed = 0;
    const runtime = Runtime.fromKv({
      name: "scoped-memory",
      backend: Layer.effect(
        KvBackend,
        Effect.acquireRelease(
          Effect.sync(() => {
            opened++;
            return makeTestKvBackend();
          }),
          () =>
            Effect.sync(() => {
              closed++;
            }),
        ),
      ),
    });
    await Effect.runPromise(
      Triples.pipe(Effect.provide(runtime.layer({ scope, capabilities: Capabilities.none }))),
    );
    expect([opened, closed]).toEqual([1, 1]);
    const duplicate = {
      name: "duplicate",
      priority: 1,
      requires: [],
      wrap: (store: typeof Triples.Service) => store,
    };
    await Effect.runPromiseExit(
      Triples.pipe(
        Effect.provide(
          runtime.layer({
            scope,
            capabilities: Capabilities.custom(duplicate, duplicate),
          }),
        ),
      ),
    );
    expect([opened, closed]).toEqual([2, 2]);
  });

  it("supports non-SQL adapters and releases resources when initialization fails", async () => {
    let closed = 0;
    const unused = () => Effect.die("unused operation");
    const failure = new MigrationError({
      version: 1,
      name: "fixture",
      message: "initialization failed",
    });
    const storage = Layer.effect(
      StorageAdapter,
      Effect.acquireRelease(
        Effect.succeed({
          withTransaction: <A, E>(effect: Effect.Effect<A, E>) => effect,
          nextCommitPosition: unused,
          currentCommitPosition: unused,
          dependencyState: unused,
          claimCommand: unused,
          insert: unused,
          batchInsert: unused,
          retract: unused,
          getById: unused,
          getByEntity: unused,
          getByEntities: unused,
          query: unused,
          history: unused,
          initialize: () => Effect.fail(failure),
          close: () => Effect.void,
        }),
        () =>
          Effect.sync(() => {
            closed++;
          }),
      ),
    );
    const runtime = Runtime.define({
      name: "non-sql",
      storage,
      queries: Layer.succeed(QueryExecutor, {
        execute: unused,
        executePage: unused,
        explain: unused,
        explainPage: unused,
      }),
    });
    const error = await Effect.runPromise(
      Triples.pipe(
        Effect.provide(
          runtime.layer({
            scope,
            capabilities: Capabilities.none,
          }),
        ),
        Effect.flip,
      ),
    );
    expect(error).toBe(failure);
    expect(closed).toBe(1);
  });
});
