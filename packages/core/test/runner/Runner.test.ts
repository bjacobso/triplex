import { expect, it } from "vitest";
import { Clock, Effect } from "effect";
import { TestClock } from "effect/testing";
import { EntityId, KvTriples, Triples, string } from "../../src/index.js";
import { DatabaseScope } from "../../src/runtime/index.js";
import * as Derivation from "../../src/derivation/index.js";
import * as Runner from "../../src/runner/index.js";

it("delivers bootstrap from the captured cut and rejects a second local owner", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(110);
      const t = yield* Triples;
      const tx = yield* t.transact([
        {
          op: "assert",
          entityId: EntityId.make("a"),
          attribute: ":test/value",
          value: string("a"),
          validFrom: 0,
        },
      ]);
      const definition = yield* Derivation.make({
        name: "test",
        query: { find: ["?e"], where: [["?e", ":test/value", "?v"]] },
        identity: ["?e"],
        configSnapshot: "test",
      });
      const deliveries: Runner.Delivery[] = [];
      const options = { scope: DatabaseScope.test("runner"), id: "test" };
      const registrations = [
        {
          key: "test",
          definition,
          onDiff: (d: Runner.Delivery) =>
            Effect.sync(() => {
              deliveries.push(d);
            }),
        },
      ];
      const handle = yield* Runner.start(registrations, options);
      while (deliveries.length === 0) yield* Effect.yieldNow;
      expect((yield* t.transaction(tx.txId))?.instant).toBe(110);
      expect(deliveries[0]?.position).toBe(tx.position);
      expect(deliveries[0]?.diff.added).toHaveLength(1);
      const duplicate = yield* Effect.result(Runner.start(registrations, options));
      expect(duplicate._tag === "Failure" && duplicate.failure.code).toBe("AlreadyRunning");
      yield* handle.stop;
    }).pipe(
      Effect.scoped,
      Effect.provide(KvTriples.layerWithClock(Clock.currentTimeMillis)),
      Effect.provide(TestClock.layer()),
    ),
  );
});

it("reads durable consumer progress after the wall clock moves backwards", async () => {
  const { ConsumerCheckpoint } = await import("../../src/operational/index.js");
  await Effect.runPromise(
    Effect.gen(function* () {
      const t = yield* Triples;
      yield* TestClock.setTime(10);
      const first = yield* t.transact([]);
      yield* ConsumerCheckpoint.advance(t, {
        consumer: "rollback",
        expectedPosition: 0,
        nextPosition: first.position,
      });
      yield* TestClock.setTime(20);
      const second = yield* t.transact([]);
      yield* ConsumerCheckpoint.advance(t, {
        consumer: "rollback",
        expectedPosition: first.position,
        nextPosition: second.position,
      });
      yield* TestClock.setTime(15);
      expect((yield* ConsumerCheckpoint.get(t, "rollback"))?.position).toBe(second.position);
    }).pipe(
      Effect.provide(KvTriples.layerWithClock(Clock.currentTimeMillis)),
      Effect.provide(TestClock.layer()),
    ),
  );
});
