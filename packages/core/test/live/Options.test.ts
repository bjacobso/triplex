import { expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { KvTriples } from "../../src/index.js";
import { DatabaseScope } from "../../src/runtime/index.js";
import { LiveQuery } from "../../src/live/index.js";
import type { DatalogQuery, WrappedQuery } from "../../src/datalog/types.js";

const raw: DatalogQuery = { find: ["?v"], where: [["?e", ":watch/value", "?v"]] };
it("rejects invalid options, pinned recorded bases, and continuation cursors before registration", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const live = yield* LiveQuery;
        for (const [query, options] of [
          [raw, { coalesceMs: -1 }],
          [raw, { maxRows: 0 }],
          [raw, { coalesceMs: 1.5 }],
          [raw, { validTime: { mode: "fixed", at: -1 } }],
          [{ ...raw, recordedPosition: 0 }, {}],
          [{ inner: raw, cursor: "old" }, {}],
          [{ ...raw, validTime: "all" }, { validTime: { mode: "now" } }],
        ] as const) {
          const result = yield* Effect.result(
            live.watch(query as DatalogQuery | WrappedQuery, options).pipe(Stream.runHead),
          );
          expect(result._tag === "Failure" && result.failure._tag).toBe("WatchOptionsError");
          expect((yield* live.metrics).pendingSubscribers).toBe(0);
        }
      }),
    ).pipe(
      Effect.provide(LiveQuery.layer({ scope: DatabaseScope.test("options") })),
      Effect.provide(KvTriples.layer),
    ),
  );
});

it("gives typed failures for malformed JavaScript options and query shapes", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const live = yield* LiveQuery;
      for (const [q, options] of [
        [null, {}],
        [raw, null],
        [raw, { validTime: null }],
        [raw, { validTime: "now" }],
        [raw, { resume: 1 }],
      ] as const) {
        const exit = yield* Effect.exit(
          live.watch(q as unknown as DatalogQuery, options as never).pipe(Stream.runHead),
        );
        expect(exit._tag).toBe("Failure");
        const result = yield* Effect.result(
          live.watch(q as unknown as DatalogQuery, options as never).pipe(Stream.runHead),
        );
        expect(result._tag).toBe("Failure");
      }
    }).pipe(
      Effect.provide(LiveQuery.layer({ scope: DatabaseScope.test("malformed") })),
      Effect.provide(KvTriples.layer),
      Effect.scoped,
    ),
  );
});
