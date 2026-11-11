import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import {
  CommitValidation,
  EntityId,
  TripleId,
  KvTriples,
  TransactionConflictError,
  Triples,
  type QueryResponse,
} from "../src/index.js";

it("returns complete queryAll-shaped results from validator views", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const triples = yield* Triples;
      const query = {
        find: ["?entity"],
        where: [["?entity", ":validator/query-shape", "present"]],
      } as const;
      const ops = Array.from({ length: 101 }, (_, index) => ({
        op: "assert" as const,
        entityId: EntityId.make(`query-shape:${index}`),
        attribute: ":validator/query-shape",
        value: { type: "string" as const, value: "present" },
      }));
      let inspected: QueryResponse | undefined;
      yield* triples.transact(ops, {
        validate: [
          CommitValidation.make("query-shape", (commit) =>
            Effect.gen(function* () {
              expect(yield* commit.before.query(query)).toEqual({ results: [] });
              const after = yield* commit.after.query(query);
              expect(after.results).toHaveLength(101);
              expect(after.nextCursor).toBeUndefined();
              inspected = after;
            }),
          ),
        ],
      });
      expect(inspected).toEqual(yield* triples.queryAll(query));
    }).pipe(Effect.provide(KvTriples.layer)),
  );
});

it("preserves retryable conflicts through every decorated convenience write", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const inner = yield* Triples;
      const conflict = new TransactionConflictError({ reason: "serialization", message: "Retry" });
      const triples = yield* Triples.pipe(
        Effect.provide(
          CommitValidation.layer({ validators: [] }).pipe(
            Layer.provide(
              Layer.succeed(Triples, {
                ...inner,
                transact: () => Effect.fail(conflict),
              }),
            ),
          ),
        ),
      );
      for (const write of [
        triples.assert({
          entityId: EntityId.make("doc"),
          attribute: ":name",
          value: { type: "string", value: "x" },
        }),
        triples.assertBatch([
          {
            entityId: EntityId.make("doc"),
            attribute: ":name",
            value: { type: "string", value: "x" },
          },
        ]),
        triples.retract(TripleId.make("00000000000000000000000000")),
        triples.retractByPattern({ entityId: EntityId.make("doc") }),
      ]) {
        expect(yield* write.pipe(Effect.flip)).toBe(conflict);
      }
    }).pipe(Effect.provide(KvTriples.layer)),
  );
});
