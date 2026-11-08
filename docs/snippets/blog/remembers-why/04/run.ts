// #region run
import { Effect } from "effect";
import { retry } from "./story.ts";

export const answer = Effect.runSync(retry);

// answer.first.position   -> 1
// answer.receipt?.position -> 1
// answer.journal.length   -> 1
// #endregion run
