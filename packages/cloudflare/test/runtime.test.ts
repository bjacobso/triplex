import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { EntityId, Triples, number } from "@triplex-build/triplex";
import {
  Capabilities,
  DatabaseScope,
  SnapshotService,
  SnapshotWriter,
  SnapshotError,
  changeEmission,
  entitySnapshots,
  type ChangeEvent,
} from "@triplex-build/triplex/runtime";
import { SqlSnapshotsLive } from "@triplex-build/triplex-sql";
import { runtimeConformance } from "@triplex-build/triplex-testkit";
import { makeCloudflareRuntime, makeCloudflareAdapter, migrations } from "../src/index.js";
import { MIGRATIONS_TABLE_DDL } from "../src/schema.js";
import { makeMockDOState } from "./fixtures/MockDOState.js";

describe("public Cloudflare runtime", () => {
  it("upgrades a v1 database without losing facts and applies v2 once", async () => {
    const state = makeMockDOState();
    const sql = state.storage.sql;
    sql.exec(MIGRATIONS_TABLE_DDL);
    for (const statement of migrations[0]!.up) sql.exec(statement);
    sql.exec(
      "INSERT INTO triplex_schema_migrations (version, name, applied_at) VALUES (1, 'triplex_baseline', 0)",
    );
    const adapter = makeCloudflareAdapter(state);
    await Effect.runPromise(
      adapter.insert(
        {
          entityId: EntityId.make("existing"),
          attribute: ":runtime/value",
          value: number(1),
        },
        null,
        1,
        "00000000000000000000000001",
        1,
      ),
    );
    await Effect.runPromise(adapter.initialize());
    await Effect.runPromise(adapter.initialize());
    expect(await Effect.runPromise(adapter.getByEntity("existing"))).toHaveLength(1);
    expect(
      sql.exec("SELECT version FROM triplex_schema_migrations ORDER BY version").toArray(),
    ).toEqual([{ version: 1 }, { version: 2 }]);
    expect(sql.exec("SELECT * FROM entity_snapshots").toArray()).toEqual([]);
  });
  it("passes shared conformance through the public builder", async () => {
    await Effect.runPromise(
      runtimeConformance(makeCloudflareRuntime(makeMockDOState()), {
        scope: DatabaseScope.test("cloudflare-conformance"),
        capabilities: Capabilities.none,
      }),
    );
  });

  it("persists snapshots and emits exact pattern retractions", async () => {
    const state = makeMockDOState();
    const scope = DatabaseScope.test("cloudflare-capabilities");
    const events: ChangeEvent[] = [];
    const capabilities = Capabilities.of(
      entitySnapshots(SqlSnapshotsLive),
      changeEmission({
        emit: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      }),
    );
    const database = () => makeCloudflareRuntime(state).layer({ scope, capabilities });
    const ids = [EntityId.make("runtime:a"), EntityId.make("runtime:b")];
    await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const snapshots = yield* SnapshotService;
        yield* triples.transact(
          ids.map((entityId) => ({
            op: "assert" as const,
            entityId,
            attribute: ":runtime/value",
            value: number(1),
          })),
        );
        for (const entityId of ids)
          expect((yield* snapshots.current(entityId))?.attributes[":runtime/value"]).toBeDefined();
        const result = yield* triples.transact([
          {
            op: "retract-pattern",
            pattern: { attribute: ":runtime/value" },
          },
        ]);
        for (const entityId of ids) {
          const snapshot = yield* snapshots.current(entityId);
          expect(snapshot?.txId).toBe(result.txId);
          expect(snapshot?.attributes[":runtime/value"]).toBeUndefined();
        }
      }).pipe(Effect.provide(database())),
    );
    expect(events).toHaveLength(2);
    expect(events[1]?.changes).toHaveLength(2);
    expect(events[1]?.changes.every((change) => change.operation === "retract")).toBe(true);
    // Persistence survives closing and rebuilding the runtime over the same database.
    await Effect.runPromise(
      Effect.gen(function* () {
        const snapshots = yield* SnapshotService;
        expect(yield* snapshots.hashes(ids[0]!)).toHaveLength(2);
      }).pipe(Effect.provide(database())),
    );
  });

  it("reports projection failure after commit without claiming the write rolled back", async () => {
    const failure = new SnapshotError({ message: "projection unavailable" });
    // Override the writer after acquiring the real reader.
    const failingSnapshots = Layer.merge(
      SqlSnapshotsLive,
      Layer.succeed(SnapshotWriter, {
        materialize: () => Effect.fail(failure),
        backfill: () => Effect.fail(failure),
      }),
    );
    const entityId = EntityId.make("runtime:committed");
    await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const error = yield* triples
          .assert({
            entityId,
            attribute: ":runtime/value",
            value: number(1),
          })
          .pipe(Effect.flip);
        expect(error._tag).toBe("WriteError");
        expect(yield* triples.entity(entityId)).toHaveLength(1);
      }).pipe(
        Effect.provide(
          makeCloudflareRuntime(makeMockDOState()).layer({
            scope: DatabaseScope.test("projection-failure"),
            capabilities: Capabilities.of(entitySnapshots(failingSnapshots)),
          }),
        ),
      ),
    );
  });
});
