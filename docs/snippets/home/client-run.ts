import { Effect } from "effect";
import { main } from "./client.ts";

const result = await Effect.runPromise(main);
console.log(
  JSON.stringify({
    receipt: result.receipt,
    retry: result.retry,
    worker: result.worker?.values,
    current: result.current?.values,
    knownThen: result.knownThen?.values,
    explanation: result.explanation,
  }),
);
