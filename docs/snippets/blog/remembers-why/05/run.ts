// #region run
import { Effect } from "effect";
import { correction } from "./story.ts";

export const answer = Effect.runSync(correction);

// answer.message:
// Expected boolean
//   at [":worker/trained"]
// answer.journal.length -> 1
// answer.receipt        -> undefined
// #endregion run
