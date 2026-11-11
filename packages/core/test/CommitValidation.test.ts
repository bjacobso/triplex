import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import {
  CommitValidation,
  EntityId,
  TripleId,
  KvTriples,
  TransactionConflictError,
  Triples,
} from "../src/index.js";

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
