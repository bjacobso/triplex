// #region run
import { Effect } from "effect";
import { twoClocks } from "./story.ts";

export const answer = Effect.runSync(twoClocks);

// answer.asKnownThen.map((f) => f.id) -> ["training:1"]
// answer.asKnownNow.map((f) => f.id)  -> []
// answer.january.map((f) => f.id)     -> ["training:2"]
// #endregion run
