// #region run
import { Effect } from "effect";
import { correction } from "./story.ts";

export const answer = Effect.runSync(correction);

// answer.current[0].value is false.
// answer.journal[0].changes[0].fact.value is still true.
// #endregion run
