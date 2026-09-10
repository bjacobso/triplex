import { Effect, Layer } from "effect";
import { EntityId, KvTriples, Triples } from "@triplex-build/triplex";
import {
  Attribute,
  ConfigStore,
  EntityType,
  GraphConstraint,
  InMemoryConfigStore,
} from "@triplex-build/triplex/config";

const CourseTitle = Attribute.text(":course/title");
const CourseStatus = Attribute.enumOf(":course/status", ["draft", "published"]);

const CourseV1 = EntityType.make("Course", {
  attributes: {
    title: Attribute.use(CourseTitle, { required: true }),
  },
});

const CourseV2 = EntityType.make("Course", {
  attributes: {
    title: Attribute.use(CourseTitle, { required: true }),
    status: Attribute.use(CourseStatus, { required: true }),
  },
});

const program = Effect.gen(function* () {
  const config = yield* ConfigStore.ConfigStore;
  const triples = yield* Triples;

  // Publish v1 to test, then promote that exact returned snapshot to live.
  const v1 = yield* config.commit({
    label: "courses-2026.1",
    objects: yield* CourseV1.nodes,
    ref: "test",
  });
  yield* config.setRef("live", v1.snapshot.id);

  yield* triples.transact(
    [
      {
        op: "assert",
        entityId: EntityId.make("course:intro"),
        entityType: CourseV1.entityType,
        ...CourseV1.title.assertion("Introduction to temporal data"),
      },
    ],
    {
      actor: "user:publisher",
      commandId: "courses/create-intro/v1",
      configSnapshot: v1.snapshot.id,
      enforce: GraphConstraint.enforcement(CourseV1.constraints),
    },
  );

  // Publish a complete v2 graph without changing live, inspect it, then promote it.
  const v2 = yield* config.commit({
    label: "courses-2026.2",
    objects: yield* CourseV2.nodes,
    ref: "test",
  });
  const testBeforePromotion = yield* config.resolveRef("test");
  yield* config.setRef("live", v2.snapshot.id);

  yield* triples.transact(
    [
      {
        op: "assert",
        entityId: EntityId.make("course:advanced"),
        entityType: CourseV2.entityType,
        ...CourseV2.title.assertion("Advanced temporal data"),
      },
      {
        op: "assert",
        entityId: EntityId.make("course:advanced"),
        entityType: CourseV2.entityType,
        ...CourseV2.status.assertion("published"),
      },
    ],
    {
      actor: "user:publisher",
      commandId: "courses/create-advanced/v1",
      configSnapshot: v2.snapshot.id,
      enforce: GraphConstraint.enforcement(CourseV2.constraints),
    },
  );

  const state = yield* config.load();
  const changes = InMemoryConfigStore.changesBetween(state, v1.snapshot, v2.snapshot);
  const historicalV2 = yield* config.snapshotById(v2.snapshot.id);
  const v2Receipt = yield* triples.transactionByCommand("courses/create-advanced/v1");

  // Roll back configuration by moving live. Operational facts and their pins remain.
  yield* config.setRef("live", v1.snapshot.id);
  const liveAfterRollback = yield* config.resolveRef("live");
  const advancedCourse = yield* triples.entity(EntityId.make("course:advanced"));

  return {
    v1Snapshot: v1.snapshot.id,
    v2Snapshot: v2.snapshot.id,
    testBeforePromotion: testBeforePromotion?.label,
    changedObjects: changes.map((change) => `${change.kind}:${change.key}`),
    historicalV2: historicalV2?.label,
    v2WritePin: v2Receipt?.configSnapshot,
    liveAfterRollback: liveAfterRollback?.label,
    advancedFactsAfterRollback: advancedCourse.length,
  };
});

const AppLayer = ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer));
const result = await Effect.runPromise(program.pipe(Effect.provide(AppLayer)));

console.log(JSON.stringify(result, null, 2));
