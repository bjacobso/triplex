import { Effect } from "effect";
import { EntityId, KvTriples, Triples, ref } from "@triplex-build/triplex";

const student = EntityId.make("student:ada");
const quiz = EntityId.make("quiz:logic-1");
const submission = EntityId.make("submission:ada:logic-1");

export const submitQuiz = Effect.gen(function* () {
  const triples = yield* Triples;

  return yield* triples.transact(
    [
      {
        op: "assert",
        entityId: submission,
        entityType: "Submission",
        attribute: ":submission/student",
        value: ref(student),
      },
      {
        op: "assert",
        entityId: submission,
        entityType: "Submission",
        attribute: ":submission/quiz",
        value: ref(quiz),
      },
    ],
    {
      actor: "teacher:grace",
      commandId: "submit:ada:logic-1",
      configSnapshot: "config:learning-2026.1",
    },
  );
}).pipe(Effect.provide(KvTriples.layer));
