import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit } from "effect";
import { Triples } from "@bjacobso/triplex";
import { makeTriplesConformanceSuite } from "@bjacobso/triplex-testkit";
import { CloudflareTriples, makeCloudflareAdapter } from "../src/index.js";
import { makeMockDOState } from "./fixtures/MockDOState.js";

describe("Cloudflare Durable Object Triples", () => {
  it("matches the shared backend contract", async () => {
    await expect(
      Effect.runPromise(
        makeTriplesConformanceSuite().pipe(
          Effect.provide(
            CloudflareTriples.layer({
              state: makeMockDOState(),
              scope: "test:tenant-a:default:generation-a",
            }),
          ),
          Effect.scoped,
        ) as Effect.Effect<void, unknown, never>,
      ),
    ).resolves.toBeUndefined();
  });

  it("binds opaque cursors to the complete database scope", async () => {
    const stateA = makeMockDOState();
    const stateB = makeMockDOState();
    const first = await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        yield* triples.assertBatch([
          {
            entityId: "scope:a" as never,
            attribute: ":scope/value",
            value: { type: "number", value: 1 },
          },
          {
            entityId: "scope:b" as never,
            attribute: ":scope/value",
            value: { type: "number", value: 2 },
          },
        ]);
        return yield* triples.queryPage({
          inner: { find: ["?value"], where: [["?entity", ":scope/value", "?value"]] },
          orderBy: [{ variable: "?value" }],
          limit: 1,
        });
      }).pipe(
        Effect.provide(
          CloudflareTriples.layer({
            state: stateA,
            scope: "test:tenant-a:default:generation-a",
          }),
        ),
      ),
    );

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const triples = yield* Triples;
        return yield* triples.queryPage({
          inner: { find: ["?value"], where: [["?entity", ":scope/value", "?value"]] },
          orderBy: [{ variable: "?value" }],
          limit: 1,
          cursor: first.nextCursor,
        });
      }).pipe(
        Effect.provide(
          CloudflareTriples.layer({
            state: stateB,
            scope: "test:tenant-b:default:generation-b",
          }),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("PaginationCursorError");
    }
  });

  it("rolls back typed failures, defects, and asynchronous transaction effects", async () => {
    const state = makeMockDOState();
    const adapter = makeCloudflareAdapter(state);
    await Effect.runPromise(adapter.initialize());

    const assertEmpty = async () => {
      const rows = await Effect.runPromise(adapter.rawQuery("SELECT * FROM triples", []));
      expect(rows).toEqual([]);
    };
    const insert = adapter.insert(
      {
        entityId: "rollback" as never,
        attribute: ":rollback/value",
        value: { type: "string", value: "uncommitted" },
      },
      "_tx/rollback" as never,
      1,
      "rollback-triple" as never,
      1,
    );

    await Effect.runPromiseExit(
      adapter.withTransaction(insert.pipe(Effect.andThen(Effect.fail("typed")))),
    );
    await assertEmpty();

    await Effect.runPromiseExit(
      adapter.withTransaction(insert.pipe(Effect.andThen(Effect.die("defect")))),
    );
    await assertEmpty();

    await Effect.runPromiseExit(
      adapter.withTransaction(insert.pipe(Effect.andThen(Effect.sleep("1 millis")))),
    );
    await assertEmpty();
  });
});
