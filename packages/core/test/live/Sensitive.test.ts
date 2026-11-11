import { expect, it } from "vitest";
import { Effect, Layer, Stream } from "effect";
import { KvTriples } from "../../src/index.js";
import { LiveQuery } from "../../src/live/index.js";
import { DatabaseScope } from "../../src/runtime/index.js";
import { KeyProvider, Sensitive, ValueCodec } from "../../src/sensitive/index.js";
import * as Attribute from "../../src/config/Attribute.js";
import * as EntityType from "../../src/config/EntityType.js";
const Person = EntityType.make("LivePerson", {
  secret: Attribute.sensitive(Attribute.text(":live/secret")),
});
it("preserves the sensitive query planner's typed rejection", async () => {
  const store = Sensitive.layer({ database: "test/live", attributes: [Person] }).pipe(
    Layer.provide(ValueCodec.aesGcm.pipe(Layer.provide(KeyProvider.test({ seed: "live" })))),
    Layer.provide(KvTriples.layer),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const live = yield* LiveQuery;
      const result = yield* Effect.result(
        live
          .watch({ find: ["?secret"], where: [["?person", ":live/secret", "?secret"]] })
          .pipe(Stream.runHead),
      );
      expect(result._tag === "Failure" && result.failure._tag).toBe("SensitiveQueryError");
      expect((yield* live.metrics).pendingSubscribers).toBe(0);
    }).pipe(
      Effect.provide(LiveQuery.layer({ scope: DatabaseScope.test("sensitive-live") })),
      Effect.provide(store),
      Effect.scoped,
    ),
  );
});
