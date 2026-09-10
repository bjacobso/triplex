import { Effect } from "effect";
import { Attribute, ConfigStore, EntityType } from "@triplex-build/triplex/config";

const StudentName = Attribute.text(":student/name");

const Student = EntityType.make("Student", {
  attributes: {
    name: Attribute.use(StudentName, {
      required: true,
      unique: true,
    }),
  },
});

export const publishSchema = Effect.gen(function* () {
  const config = yield* ConfigStore.ConfigStore;

  return yield* config.commit({
    label: "learning-2026.1",
    objects: yield* Student.nodes,
    ref: "live",
  });
});
