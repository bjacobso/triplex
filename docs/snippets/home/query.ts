import { Effect } from "effect";
import { Triples } from "@triplex-build/triplex";

export const openGradingTasks = Effect.gen(function* () {
  const triples = yield* Triples;

  return yield* triples.query({
    find: ["?student", "?quiz"],
    where: [
      ["?submission", ":submission/student", "?student"],
      ["?submission", ":submission/quiz", "?quiz"],
      ["not", ["?submission", ":submission/grade", "?grade"]],
    ],
  });
});
