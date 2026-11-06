// Probe: which shapes of conjunctive `not` / multi-clause `or` does the query schema accept?
import { Effect } from "effect";
import { EntityId, KvTriples, Triples, string, boolean } from "@triplex-build/triplex";

const shapes: Record<string, unknown[]> = {
  notMulti: [["?v", ":v/name", "?n"], ["not", ["?r", ":r/vendor", "?v"], ["?r", ":r/ok", true]]],
  notAnd: [["?v", ":v/name", "?n"], ["not", ["and", ["?r", ":r/vendor", "?v"], ["?r", ":r/ok", true]]]],
  orNested: [["?v", ":v/name", "?n"], ["or", [[["?v", ":v/a", true], ["?v", ":v/b", true]], [["?v", ":v/c", true]]]]],
  orAnd: [["?v", ":v/name", "?n"], ["or", [["and", ["?v", ":v/a", true], ["?v", ":v/b", true]], ["?v", ":v/c", true]]]],
  orWithNot: [["?v", ":v/name", "?n"], ["or", [["not", ["?v", ":v/a", true]], ["?v", ":v/c", true]]]],
  typo: [["?v", ":v/nmae", "?n"]],
};
const program = Effect.gen(function* () {
  const t = yield* Triples;
  const v = EntityId.make("v:1");
  yield* t.transact([
    { op: "assert", entityId: v, attribute: ":v/name", value: string("one") },
    { op: "assert", entityId: v, attribute: ":v/c", value: boolean(true) },
  ], { actor: "probe", commandId: "probe:1" });
  for (const [name, where] of Object.entries(shapes)) {
    const r = yield* Effect.result(t.query({ find: ["?v"], where } as never));
    console.log(name, "=>", r._tag === "Success" ? JSON.stringify(r.success.results) : String((r as any).failure?.message ?? JSON.stringify((r as any).failure)).slice(0, 300));
  }
});
Effect.runPromise(program.pipe(Effect.provide(KvTriples.layer))).catch((e) => console.error("FATAL", e));
