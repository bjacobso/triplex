import { Effect } from "effect";
import { main } from "./client-site-safety.ts";

console.log(JSON.stringify(await Effect.runPromise(main)));
