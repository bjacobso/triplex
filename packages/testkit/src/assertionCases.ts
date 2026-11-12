import { Effect, Option } from "effect";
import { EntityId, TripleId, Triples, string } from "@triplex-internal/core";

/** Public identity reads distinguish live assertions from retained history. */
export const assertionConformance = Effect.gen(function* () {
  const triples = yield* Triples;
  const check = (ok: boolean, message: string) =>
    ok ? Effect.void : Effect.fail(new Error(message));
  const missing = TripleId.make("00000000000000000000000000");
  yield* check((yield* triples.get(missing)) === null, "get missing");
  yield* check((yield* triples.assertion(missing)) === null, "assertion missing");
  const written = yield* triples.transact([
    {
      op: "assert",
      entityId: EntityId.make("assertion:entity"),
      attribute: ":assertion/value",
      value: string("retained"),
      validFrom: 100,
      validTo: 200,
    },
  ]);
  const id = written.triples[0]!.id;
  yield* check((yield* triples.get(id))?.id === id, "get ignores valid-time visibility");
  yield* check((yield* triples.assertion(id))?.id === id, "assertion returns live assertion");
  const retracted = yield* triples.transact([{ op: "retract", id }]);
  yield* check((yield* triples.get(id)) === null, "get excludes retracted assertion");
  const retained = yield* triples.assertion(id);
  yield* check(
    retained !== null &&
      Option.getOrNull(retained.retractedAt) === retracted.instant &&
      Option.getOrNull(retained.retractTxId) === retracted.txId &&
      retained.validFrom === 100 &&
      Option.getOrNull(retained.validTo) === 200 &&
      retained.value.type === "string" &&
      retained.value.value === "retained",
    "assertion retains intervals, attribution and value",
  );
});
