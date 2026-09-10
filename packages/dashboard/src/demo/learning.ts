import {
  EntityId,
  Triples,
  datetime,
  json,
  number,
  ref,
  string,
  type DatalogQuery as DatalogQueryType,
} from "@triplex-build/triplex";
import { ConfigNode, ConfigStore, TypeExpr } from "@triplex-build/triplex/config";
import * as Derivation from "@triplex-build/triplex/derivation";
import { Effect } from "effect";

const DAY = 86_400_000;

const PERSON_NAME = ":person/name";
const COURSE_TITLE = ":course/title";
const COURSE_TEACHER = ":course/teacher";
const ENROLLMENT_STUDENT = ":enrollment/student";
const ENROLLMENT_COURSE = ":enrollment/course";
const QUIZ_TITLE = ":quiz/title";
const QUIZ_COURSE = ":quiz/course";
const QUIZ_FORM = ":quiz/form";
const QUIZ_DUE_AT = ":quiz/due-at";
const SUBMISSION_STUDENT = ":submission/student";
const SUBMISSION_QUIZ = ":submission/quiz";
const SUBMISSION_STATUS = ":submission/status";
const SUBMISSION_ANSWERS = ":submission/answers";
const SUBMISSION_SUBMITTED_AT = ":submission/submitted-at";
const SUBMISSION_SCORE = ":submission/score";
const SUBMISSION_GRADED_AT = ":submission/graded-at";

const ids = {
  teacher: EntityId.make("teacher:ada-morgan"),
  mina: EntityId.make("student:mina-patel"),
  leo: EntityId.make("student:leo-chen"),
  noa: EntityId.make("student:noa-williams"),
  priya: EntityId.make("student:priya-shah"),
  sam: EntityId.make("student:sam-okafor"),
  yuki: EntityId.make("student:yuki-tanaka"),
  course: EntityId.make("course:data-systems-201"),
  minaEnrollment: EntityId.make("enrollment:mina-data-systems"),
  leoEnrollment: EntityId.make("enrollment:leo-data-systems"),
  quiz: EntityId.make("quiz:bitemporal-facts"),
  minaSubmission: EntityId.make("submission:mina-bitemporal-facts"),
  leoSubmission: EntityId.make("submission:leo-bitemporal-facts"),
} as const;

const descriptorType = TypeExpr.struct({
  label: TypeExpr.required(TypeExpr.text),
  description: TypeExpr.required(TypeExpr.text),
  version: TypeExpr.required(TypeExpr.integer),
  valueType: TypeExpr.optional(TypeExpr.text),
});

const derivationDescriptorType = TypeExpr.struct({
  label: TypeExpr.required(TypeExpr.text),
  description: TypeExpr.required(TypeExpr.text),
  version: TypeExpr.required(TypeExpr.integer),
  query: TypeExpr.required(TypeExpr.any),
  identity: TypeExpr.required(TypeExpr.list(TypeExpr.text)),
});

const formDescriptorType = TypeExpr.struct({
  renderer: TypeExpr.required(TypeExpr.text),
  title: TypeExpr.required(TypeExpr.text),
  description: TypeExpr.required(TypeExpr.text),
  submitLabel: TypeExpr.required(TypeExpr.text),
  version: TypeExpr.required(TypeExpr.integer),
});

const fieldDescriptorType = TypeExpr.struct({
  name: TypeExpr.required(TypeExpr.text),
  label: TypeExpr.required(TypeExpr.text),
  description: TypeExpr.required(TypeExpr.text),
  input: TypeExpr.required(TypeExpr.enumOf(["text", "textarea", "select"])),
  required: TypeExpr.required(TypeExpr.boolean),
  options: TypeExpr.required(TypeExpr.list(TypeExpr.text)),
});

const gradingQuery: DatalogQueryType = {
  find: ["?submission", "?studentName", "?quizTitle", "?teacherName", "?status"],
  where: [
    ["?submission", SUBMISSION_STATUS, "?status"],
    ["=", "?status", "submitted"],
    ["?submission", SUBMISSION_STUDENT, "?student"],
    ["?student", PERSON_NAME, "?studentName"],
    ["?submission", SUBMISSION_QUIZ, "?quiz"],
    ["?quiz", QUIZ_TITLE, "?quizTitle"],
    ["?quiz", QUIZ_COURSE, "?course"],
    ["?course", COURSE_TEACHER, "?teacher"],
    ["?teacher", PERSON_NAME, "?teacherName"],
  ],
};

const node = (input: {
  readonly kind: string;
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly valueType?: string;
  readonly refs?: readonly ConfigNode.ConfigRef[];
}) =>
  ConfigNode.makeTyped({
    kind: input.kind,
    key: input.key,
    type: descriptorType,
    attrs: {
      label: input.label,
      description: input.description,
      version: 1,
      ...(input.valueType === undefined ? {} : { valueType: input.valueType }),
    },
    ...(input.refs === undefined ? {} : { refs: input.refs }),
  });

const gradingDefinition = (configSnapshot: string) =>
  Derivation.make({
    name: "grading.task",
    query: gradingQuery,
    identity: ["?submission"],
    configSnapshot,
  });

/** Optional classroom fixture. The dashboard itself has no knowledge of this model. */
export const seedLearningDemo = Effect.gen(function* () {
  const triples = yield* Triples;
  const config = yield* ConfigStore.ConfigStore;
  let release = yield* config.resolveRef("live");

  if (release === undefined) {
    const personName = yield* node({
      kind: "attribute",
      key: PERSON_NAME,
      label: "Person name",
      description: "The display name shared by students and teachers.",
      valueType: "string",
    });
    const courseTeacher = yield* node({
      kind: "attribute",
      key: COURSE_TEACHER,
      label: "Course teacher",
      description: "The teacher responsible for a course.",
      valueType: "ref",
      refs: [
        {
          rel: "references-entity-type",
          kind: "entity-type",
          key: "Teacher",
        },
      ],
    });
    const submissionStatus = yield* node({
      kind: "attribute",
      key: SUBMISSION_STATUS,
      label: "Submission status",
      description: "Whether a quiz submission is submitted or graded.",
      valueType: "string",
    });
    const teacherType = yield* node({
      kind: "entity-type",
      key: "Teacher",
      label: "Teacher",
      description: "An instructor who owns courses and grading work.",
      refs: [{ rel: "uses", kind: "attribute", key: PERSON_NAME }],
    });
    const studentType = yield* node({
      kind: "entity-type",
      key: "Student",
      label: "Student",
      description: "A learner enrolled in courses and completing quizzes.",
      refs: [{ rel: "uses", kind: "attribute", key: PERSON_NAME }],
    });
    const courseType = yield* node({
      kind: "entity-type",
      key: "Course",
      label: "Course",
      description: "A course taught by one teacher with an enrolled roster.",
      refs: [{ rel: "uses", kind: "attribute", key: COURSE_TEACHER }],
    });
    const submissionType = yield* node({
      kind: "entity-type",
      key: "QuizSubmission",
      label: "Quiz submission",
      description: "A student's immutable answers and mutable grading state.",
      refs: [{ rel: "uses", kind: "attribute", key: SUBMISSION_STATUS }],
    });
    const validTimeField = yield* ConfigNode.makeTyped({
      kind: "form.field",
      key: "valid-time-definition",
      type: fieldDescriptorType,
      attrs: {
        name: "validTimeDefinition",
        label: "What does valid time describe?",
        description: "Answer in one or two sentences.",
        input: "textarea",
        required: true,
        options: [],
      },
    });
    const correctionField = yield* ConfigNode.makeTyped({
      kind: "form.field",
      key: "correction-axis",
      type: fieldDescriptorType,
      attrs: {
        name: "correctionAxis",
        label: "Which axis records when the database learned a correction?",
        description: "Choose the temporal axis that represents knowledge history.",
        input: "select",
        required: true,
        options: ["recorded time", "valid time"],
      },
    });
    const quizFormV1 = yield* ConfigNode.makeTyped({
      kind: "form",
      key: "quiz/bitemporal-facts",
      type: formDescriptorType,
      attrs: {
        renderer: "triplex.form/v1",
        title: "Bitemporal Facts Check-in",
        description:
          "A short quiz from Data Systems 201. This preview is rendered entirely from the pinned configuration node.",
        submitLabel: "Validate answers",
        version: 1,
      },
      children: [{ rel: "field", node: validTimeField }],
      refs: [{ rel: "submits", kind: "entity-type", key: "QuizSubmission" }],
    });
    const quizForm = yield* ConfigNode.makeTyped({
      kind: "form",
      key: "quiz/bitemporal-facts",
      type: formDescriptorType,
      attrs: {
        renderer: "triplex.form/v1",
        title: "Bitemporal Facts Check-in",
        description:
          "A short quiz from Data Systems 201. This preview is rendered entirely from the pinned configuration node.",
        submitLabel: "Validate answers",
        version: 1,
      },
      children: [
        { rel: "field", node: validTimeField },
        { rel: "field", node: correctionField },
      ],
      refs: [{ rel: "submits", kind: "entity-type", key: "QuizSubmission" }],
    });
    const gradingPolicy = yield* node({
      kind: "policy",
      key: "quiz-submission-needs-grading",
      label: "Submitted quizzes need grading",
      description: "A submitted quiz remains actionable until a teacher records a grade.",
      refs: [
        { rel: "reads", kind: "entity-type", key: "QuizSubmission" },
        { rel: "reads", kind: "attribute", key: SUBMISSION_STATUS },
      ],
    });
    const gradingDerivation = yield* ConfigNode.makeTyped({
      kind: "derivation",
      key: "grading.task",
      type: derivationDescriptorType,
      attrs: {
        label: "Open grading task",
        description: "Produces one candidate for each submitted quiz awaiting a teacher grade.",
        version: 1,
        query: gradingQuery,
        identity: ["?submission"],
      },
      refs: [
        { rel: "implements", kind: "policy", key: "quiz-submission-needs-grading" },
        { rel: "reads", kind: "attribute", key: SUBMISSION_STATUS },
      ],
    });
    const gradingRoutine = yield* node({
      kind: "routine",
      key: "reconcile-grading-tasks",
      label: "Reconcile grading tasks",
      description: "Turns ungraded submission candidates into host-owned teacher work.",
      refs: [{ rel: "evaluates", kind: "policy", key: "quiz-submission-needs-grading" }],
    });

    const sharedObjects = [
      personName,
      courseTeacher,
      submissionStatus,
      teacherType,
      studentType,
      courseType,
      submissionType,
      gradingPolicy,
      gradingDerivation,
      gradingRoutine,
    ];
    yield* config.commit({
      label: "learning-2026.fall-beta",
      objects: [...sharedObjects, quizFormV1],
      ref: "test",
    });
    const committed = yield* config.commit({
      label: "learning-2026.fall",
      objects: [...sharedObjects, quizForm],
      ref: "live",
    });
    release = committed.snapshot;
  }

  const existing = yield* triples.transactionByCommand("dashboard/learning-seed/v1");
  if (existing !== null) return release;

  const now = Date.now();
  yield* triples.transact(
    [
      {
        op: "assert",
        entityId: ids.teacher,
        entityType: "Teacher",
        attribute: PERSON_NAME,
        value: string("Ada Morgan"),
        validFrom: now - 365 * DAY,
      },
      {
        op: "assert",
        entityId: ids.mina,
        entityType: "Student",
        attribute: PERSON_NAME,
        value: string("Mina Patel"),
        validFrom: now - 120 * DAY,
      },
      {
        op: "assert",
        entityId: ids.leo,
        entityType: "Student",
        attribute: PERSON_NAME,
        value: string("Leo Chen"),
        validFrom: now - 120 * DAY,
      },
      {
        op: "assert",
        entityId: ids.noa,
        entityType: "Student",
        attribute: PERSON_NAME,
        value: string("Noa Williams"),
        validFrom: now - 120 * DAY,
      },
      {
        op: "assert",
        entityId: ids.priya,
        entityType: "Student",
        attribute: PERSON_NAME,
        value: string("Priya Shah"),
        validFrom: now - 120 * DAY,
      },
      {
        op: "assert",
        entityId: ids.sam,
        entityType: "Student",
        attribute: PERSON_NAME,
        value: string("Sam Okafor"),
        validFrom: now - 120 * DAY,
      },
      {
        op: "assert",
        entityId: ids.yuki,
        entityType: "Student",
        attribute: PERSON_NAME,
        value: string("Yuki Tanaka"),
        validFrom: now - 120 * DAY,
      },
      {
        op: "assert",
        entityId: ids.course,
        entityType: "Course",
        attribute: COURSE_TITLE,
        value: string("Data Systems 201"),
        validFrom: now - 90 * DAY,
      },
      {
        op: "assert",
        entityId: ids.course,
        entityType: "Course",
        attribute: COURSE_TEACHER,
        value: ref(ids.teacher),
        validFrom: now - 90 * DAY,
      },
      {
        op: "assert",
        entityId: ids.minaEnrollment,
        entityType: "Enrollment",
        attribute: ENROLLMENT_STUDENT,
        value: ref(ids.mina),
        validFrom: now - 90 * DAY,
      },
      {
        op: "assert",
        entityId: ids.minaEnrollment,
        entityType: "Enrollment",
        attribute: ENROLLMENT_COURSE,
        value: ref(ids.course),
        validFrom: now - 90 * DAY,
      },
      {
        op: "assert",
        entityId: ids.leoEnrollment,
        entityType: "Enrollment",
        attribute: ENROLLMENT_STUDENT,
        value: ref(ids.leo),
        validFrom: now - 90 * DAY,
      },
      {
        op: "assert",
        entityId: ids.leoEnrollment,
        entityType: "Enrollment",
        attribute: ENROLLMENT_COURSE,
        value: ref(ids.course),
        validFrom: now - 90 * DAY,
      },
    ],
    {
      actor: "registrar:system",
      commandId: "dashboard/learning-seed/v1",
      correlationId: "term:2026-fall",
      configSnapshot: release.id,
    },
  );

  yield* triples.transact(
    [
      {
        op: "assert",
        entityId: ids.quiz,
        entityType: "Quiz",
        attribute: QUIZ_TITLE,
        value: string("Bitemporal Facts Check-in"),
        validFrom: now - 14 * DAY,
      },
      {
        op: "assert",
        entityId: ids.quiz,
        entityType: "Quiz",
        attribute: QUIZ_COURSE,
        value: ref(ids.course),
        validFrom: now - 14 * DAY,
      },
      {
        op: "assert",
        entityId: ids.quiz,
        entityType: "Quiz",
        attribute: QUIZ_FORM,
        value: string("quiz/bitemporal-facts"),
        validFrom: now - 14 * DAY,
      },
      {
        op: "assert",
        entityId: ids.quiz,
        entityType: "Quiz",
        attribute: QUIZ_DUE_AT,
        value: datetime(now + 2 * DAY),
        validFrom: now - 14 * DAY,
      },
    ],
    {
      actor: ids.teacher,
      commandId: "dashboard/publish-quiz/v1",
      correlationId: "course:data-systems-201",
      configSnapshot: release.id,
    },
  );

  yield* triples.transact(
    [
      {
        op: "assert",
        entityId: ids.minaSubmission,
        entityType: "QuizSubmission",
        attribute: SUBMISSION_STUDENT,
        value: ref(ids.mina),
      },
      {
        op: "assert",
        entityId: ids.minaSubmission,
        entityType: "QuizSubmission",
        attribute: SUBMISSION_QUIZ,
        value: ref(ids.quiz),
      },
      {
        op: "assert",
        entityId: ids.minaSubmission,
        entityType: "QuizSubmission",
        attribute: SUBMISSION_STATUS,
        value: string("submitted"),
      },
      {
        op: "assert",
        entityId: ids.minaSubmission,
        entityType: "QuizSubmission",
        attribute: SUBMISSION_ANSWERS,
        value: json({
          definition: "Valid time says when a fact is true in the modeled world.",
          correction: "recorded time",
        }),
      },
      {
        op: "assert",
        entityId: ids.minaSubmission,
        entityType: "QuizSubmission",
        attribute: SUBMISSION_SUBMITTED_AT,
        value: datetime(now - 3 * 60 * 60 * 1_000),
      },
    ],
    {
      actor: ids.mina,
      commandId: "dashboard/submit/mina/v1",
      correlationId: "quiz:bitemporal-facts",
      configSnapshot: release.id,
    },
  );

  const leoSubmission = yield* triples.transact(
    [
      {
        op: "assert",
        entityId: ids.leoSubmission,
        entityType: "QuizSubmission",
        attribute: SUBMISSION_STUDENT,
        value: ref(ids.leo),
      },
      {
        op: "assert",
        entityId: ids.leoSubmission,
        entityType: "QuizSubmission",
        attribute: SUBMISSION_QUIZ,
        value: ref(ids.quiz),
      },
      {
        op: "assert",
        entityId: ids.leoSubmission,
        entityType: "QuizSubmission",
        attribute: SUBMISSION_STATUS,
        value: string("submitted"),
      },
      {
        op: "assert",
        entityId: ids.leoSubmission,
        entityType: "QuizSubmission",
        attribute: SUBMISSION_ANSWERS,
        value: json({
          definition: "Two clocks describe truth and knowledge.",
          correction: "valid time",
        }),
      },
      {
        op: "assert",
        entityId: ids.leoSubmission,
        entityType: "QuizSubmission",
        attribute: SUBMISSION_SUBMITTED_AT,
        value: datetime(now - DAY),
      },
    ],
    {
      actor: ids.leo,
      commandId: "dashboard/submit/leo/v1",
      correlationId: "quiz:bitemporal-facts",
      configSnapshot: release.id,
    },
  );

  const leoStatus = leoSubmission.triples.find((triple) => triple.attribute === SUBMISSION_STATUS);
  if (leoStatus !== undefined) {
    yield* triples.transact(
      [
        { op: "retract", id: leoStatus.id },
        {
          op: "assert",
          entityId: ids.leoSubmission,
          entityType: "QuizSubmission",
          attribute: SUBMISSION_STATUS,
          value: string("graded"),
          validFrom: leoStatus.validFrom,
        },
        {
          op: "assert",
          entityId: ids.leoSubmission,
          entityType: "QuizSubmission",
          attribute: SUBMISSION_SCORE,
          value: number(92),
        },
        {
          op: "assert",
          entityId: ids.leoSubmission,
          entityType: "QuizSubmission",
          attribute: SUBMISSION_GRADED_AT,
          value: datetime(now - 4 * 60 * 60 * 1_000),
        },
      ],
      {
        actor: ids.teacher,
        commandId: "dashboard/grade/leo/v1",
        correlationId: "quiz:bitemporal-facts",
        causationId: leoSubmission.txId,
        configSnapshot: release.id,
      },
    );
  }

  const definition = yield* gradingDefinition(release.id);
  yield* Derivation.Materialization.materialize(triples, definition, {
    basis: { validAt: Date.now() },
  });

  return release;
});
