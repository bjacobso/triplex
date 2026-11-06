// Probe: what does a ConstraintViolationError carry when the seed fails?
import { Effect } from "effect";
import { AppLayer, seed } from "../src/seed.js";
const program = Effect.gen(function* () {
  const r = yield* Effect.result(seed);
  if (r._tag === "Failure") {
    const e = r.failure as any;
    console.log("keys:", Object.keys(e), "message:", e.message);
    console.log(JSON.stringify(e, null, 0).slice(0, 3000));
  } else console.log("ok");
});
Effect.runPromise(program.pipe(Effect.provide(AppLayer()))).catch((e) => console.error("FATAL", e));
