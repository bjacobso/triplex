import { expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { KvTriples, Triples, EntityId, string } from "../../src/index.js";
import { DatabaseScope } from "../../src/runtime/index.js";
import { LiveQuery } from "../../src/live/index.js";

it("emits an empty initial snapshot and replays every relevant commit at its exact cut", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const t = yield* Triples;
        const live = yield* LiveQuery;
        let count = 0;
        const seen = yield* live
          .watch({ find: ["?v"], where: [["?e", ":watch/value", "?v"]] })
          .pipe(
            Stream.tap(() =>
              Effect.gen(function* () {
                if (count++ === 0) {
                  yield* t.assert({
                    entityId: EntityId.make("watch:a"),
                    attribute: ":watch/value",
                    value: string("a"),
                    validFrom: 0,
                  });
                  yield* t.assert({
                    entityId: EntityId.make("watch:b"),
                    attribute: ":watch/value",
                    value: string("b"),
                    validFrom: 0,
                  });
                }
              }),
            ),
            Stream.take(3),
            Stream.runCollect,
          );
        expect(seen.map((s) => s.position)).toEqual([0, 1, 2]);
        expect(seen.map((s) => s.result.results.length)).toEqual([0, 1, 2]);
        expect(seen.map((s) => s.coveredAfter)).toEqual([null, 0, 1]);
      }),
    ).pipe(
      Effect.provide(LiveQuery.layer({ scope: DatabaseScope.test("live") })),
      Effect.provide(KvTriples.layer),
    ),
  );
});
