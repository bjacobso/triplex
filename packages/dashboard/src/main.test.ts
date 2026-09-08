import { EntityId, Triples, string } from "@bjacobso/triplex";
import { ConfigStore } from "@bjacobso/triplex/config";
import { Effect, Exit } from "effect";
import { expect as expectScene, given, role, scene, text } from "foldkit/scene";
import { describe, expect, it } from "vitest";

import {
  initialQueryText,
  executeQueryText,
  loadDashboard,
  loadEntityHistory,
  loadEntityTypePage,
  moveConfigRef,
  publishConfigChange,
  saveEntity,
} from "./data.js";
import { DashboardDemoLayer } from "./demo/layer.js";
import { LoadDashboard, Message, RunQuery, init, initialModel, update, view } from "./main.js";

describe("Triplex dashboard", () => {
  it("loads real Triplex facts, config, journal records, and derivations through a Foldkit command", async () => {
    const loaded = await Effect.runPromise(
      LoadDashboard({ recordedAt: null, validAt: null }).effect.pipe(
        Effect.provide(DashboardDemoLayer),
      ),
    );

    expect(loaded._tag).toBe("SucceededLoadDashboard");
    if (loaded._tag !== "SucceededLoadDashboard") return;
    expect(loaded.data.source).toBe("memory://demo-learning");
    expect(loaded.data.basis.recordedAt).toBeNull();
    expect(loaded.data.entities.length).toBeGreaterThanOrEqual(7);
    expect(loaded.data.transactions.length).toBeGreaterThanOrEqual(4);
    expect(loaded.data.config.refs).toContainEqual({
      name: "live",
      snapshotId: loaded.data.config.snapshotId,
    });
    expect(loaded.data.config.refs.map((ref) => ref.name).sort()).toEqual(["live", "test"]);
    expect(loaded.data.config.releases).toHaveLength(2);
    const quizFormObject = loaded.data.config.objects.find(
      (object) => object.kind === "form" && object.key === "quiz/bitemporal-facts",
    );
    expect(quizFormObject?.history).toHaveLength(2);
    expect(quizFormObject?.history[0]?.parentRevisionId).toBe(
      quizFormObject?.history[1]?.revisionId,
    );
    expect(quizFormObject?.history.map((revision) => revision.releases)).toEqual([
      ["learning-2026.fall"],
      ["learning-2026.fall-beta"],
    ]);
    expect(quizFormObject?.history[0]?.body).toContain("triplex.form/v1");
    expect(loaded.data.forms).toContainEqual(
      expect.objectContaining({
        key: "quiz/bitemporal-facts",
        fields: expect.arrayContaining([
          expect.objectContaining({ name: "validTimeDefinition", input: "textarea" }),
          expect.objectContaining({ name: "correctionAxis", input: "select" }),
        ]),
      }),
    );
    expect(loaded.data.candidates).toHaveLength(1);
    expect(loaded.data.candidates[0]?.bindings).toContainEqual({
      variable: "?studentName",
      value: "Mina Patel",
    });

    scene(
      { update, view },
      given({ ...initialModel, page: "overview", busy: false, data: loaded.data }),
      expectScene(role("heading", { name: "See the database think" })).toExist(),
      expectScene(role("button", { name: "Refresh data" })).toBeEnabled(),
      expectScene(text("?studentName = Mina Patel")).toExist(),
    );

    scene(
      { update, view },
      given({
        ...initialModel,
        page: "forms",
        busy: false,
        data: loaded.data,
        selectedFormKey: "quiz/bitemporal-facts",
      }),
      expectScene(role("heading", { name: "Bitemporal Facts Check-in" })).toExist(),
      expectScene(text("What does valid time describe?")).toExist(),
      expectScene(role("button", { name: "Validate answers" })).toBeEnabled(),
    );

    scene(
      { update, view },
      given({
        ...initialModel,
        page: "config",
        busy: false,
        data: loaded.data,
        selectedConfigObject: "form\u0000quiz/bitemporal-facts",
      }),
      expectScene(role("heading", { name: "Revision history" })).toExist(),
      expectScene(text("learning-2026.fall-beta")).toExist(),
      expectScene(role("button", { name: "Edit & publish" })).toBeEnabled(),
    );
  });

  it("executes the Datalog workbench through the same app resource layer", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* LoadDashboard({ recordedAt: null, validAt: null }).effect;
        return yield* RunQuery({
          source: initialQueryText,
          recordedAt: null,
          validAt: null,
        }).effect;
      }).pipe(Effect.provide(DashboardDemoLayer)),
    );

    expect(result._tag).toBe("SucceededRunQuery");
    if (result._tag !== "SucceededRunQuery") return;
    expect(result.result.columns).toEqual(["?entity", "?attribute", "?value"]);
    expect(result.result.rows.length).toBeGreaterThan(20);
  });

  it("cursor-pages one reflected entity type against a stable temporal snapshot", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* loadEntityTypePage("Student", null, 1);
        const triples = yield* Triples;
        yield* Effect.sleep(2);
        yield* triples.assert({
          entityId: EntityId.make("student:late-arrival"),
          entityType: "Student",
          attribute: ":person/name",
          value: string("Late Arrival"),
        });
        const second = yield* loadEntityTypePage("Student", first.nextCursor, 1);
        const wrongType = yield* Effect.exit(loadEntityTypePage("Teacher", first.nextCursor, 1));
        return { first, second, wrongType };
      }).pipe(Effect.provide(DashboardDemoLayer)),
    );

    expect(result.first.totalCount).toBe(6);
    expect(result.first.attributes).toContainEqual(
      expect.objectContaining({ attribute: ":person/name", valueType: "string" }),
    );
    expect(result.first.nextCursor).not.toBeNull();
    expect(result.second.totalCount).toBe(6);
    expect([
      ...result.first.entities.map((entity) => entity.id),
      ...result.second.entities.map((entity) => entity.id),
    ]).not.toContain("student:late-arrival");
    expect(Exit.isFailure(result.wrongType)).toBe(true);
  });

  it("applies one recorded/valid basis to dashboard, entity, and Datalog reads", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const cutoff = Date.now();
        yield* Effect.sleep(2);
        const triples = yield* Triples;
        yield* triples.assert({
          entityId: EntityId.make("student:after-temporal-cutoff"),
          entityType: "Student",
          attribute: ":person/name",
          value: string("After Temporal Cutoff"),
        });
        const validAt = Date.now();
        const latest = yield* LoadDashboard({ recordedAt: null, validAt }).effect;
        const historical = yield* LoadDashboard({ recordedAt: cutoff, validAt }).effect;
        const historicalPage = yield* loadEntityTypePage("Student", null, 100, {
          recordedAt: cutoff,
          validAt,
        });
        const historicalQuery = yield* RunQuery({
          source: JSON.stringify({
            find: ["?entity"],
            where: [["?entity", ":person/name", "After Temporal Cutoff"]],
          }),
          recordedAt: cutoff,
          validAt,
        }).effect;
        return { latest, historical, historicalPage, historicalQuery, cutoff, validAt };
      }).pipe(Effect.provide(DashboardDemoLayer)),
    );

    expect(result.latest._tag).toBe("SucceededLoadDashboard");
    expect(result.historical._tag).toBe("SucceededLoadDashboard");
    expect(result.historicalQuery._tag).toBe("SucceededRunQuery");
    if (
      result.latest._tag !== "SucceededLoadDashboard" ||
      result.historical._tag !== "SucceededLoadDashboard" ||
      result.historicalQuery._tag !== "SucceededRunQuery"
    ) {
      return;
    }
    expect(
      result.latest.data.entities.some((entity) => entity.id === "student:after-temporal-cutoff"),
    ).toBe(true);
    expect(
      result.historical.data.entities.some(
        (entity) => entity.id === "student:after-temporal-cutoff",
      ),
    ).toBe(false);
    expect(result.historical.data.basis).toEqual({
      recordedAt: result.cutoff,
      validAt: result.validAt,
    });
    expect(
      result.historicalPage.entities.some(
        (entity) => entity.id === "student:after-temporal-cutoff",
      ),
    ).toBe(false);
    expect(result.historicalQuery.result.resultCount).toBe(0);
  });

  it("bounds custom Datalog results and continues with a cursor", async () => {
    const { first, second } = await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        yield* triples.assertBatch(
          Array.from({ length: 105 }, (_, index) => ({
            entityId: EntityId.make(`dashboard:page:${index}`),
            attribute: ":dashboard/page",
            value: string(String(index)),
          })),
        );
        const source = JSON.stringify({ find: ["?e"], where: [["?e", ":dashboard/page", "?v"]] });
        const first = yield* executeQueryText(source, {});
        const second = yield* executeQueryText(source, {}, first.nextCursor!);
        return { first, second };
      }).pipe(Effect.provide(DashboardDemoLayer)),
    );
    expect(first.resultCount).toBe(100);
    expect(second.resultCount).toBe(5);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.rows, ...second.rows].map((row) => row[0])).size).toBe(105);
    const model = { ...initialModel, queryResult: first, busy: false };
    expect(update(model, Message.RequestedNextQueryPage()).commands?.[0]?.name).toBe("RunQuery");
    expect(update(model, Message.ChangedQueryText({ value: "{}" })).model.queryResult).toBeNull();
  });

  it("keeps navigation and async work explicit in update", () => {
    const started = init();
    expect(started.commands?.[0]?.name).toBe("LoadDashboard");

    const next = update(started.model, Message.SelectedPage({ page: "query" }));
    expect(next.model.page).toBe("query");

    const running = update(next.model, Message.RequestedQuery());
    expect(running.model.busy).toBe(true);
    expect(running.commands?.[0]?.name).toBe("RunQuery");
  });

  it("opens the temporal control and applies journal snap points explicitly", async () => {
    const data = await Effect.runPromise(loadDashboard.pipe(Effect.provide(DashboardDemoLayer)));
    const base = { ...initialModel, data, busy: false };
    const opened = update(base, Message.ToggledTemporalPanel());
    const transaction = data.transactions[0]!;
    const snapped = update(
      opened.model,
      Message.SelectedJournalBasis({ instant: transaction.instant }),
    );
    const applied = update(snapped.model, Message.RequestedApplyTemporalBasis());

    expect(opened.model.temporalPanelOpen).toBe(true);
    expect(snapped.model.recordedAtDraft).not.toBe("");
    expect(applied.model.recordedAt).toBe(transaction.instant);
    expect(applied.commands?.[0]?.name).toBe("LoadDashboard");
    scene(
      { update, view },
      given(opened.model),
      expectScene(text("Read the database as of…")).toExist(),
      expectScene(role("button", { name: "Apply basis" })).toBeEnabled(),
    );
  });

  it("creates and edits entities through attributed transactions with entity-scoped history", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* saveEntity({
          mode: "create",
          entityId: "student:dashboard-editor",
          entityType: "Student",
          facts: JSON.stringify([
            { attribute: ":person/name", value: { type: "string", value: "Dashboard Editor" } },
            { attribute: ":student/status", value: { type: "string", value: "active" } },
          ]),
        });
        const updated = yield* saveEntity({
          mode: "edit",
          entityId: "student:dashboard-editor",
          entityType: "Student",
          facts: JSON.stringify([
            { attribute: ":person/name", value: { type: "string", value: "Dashboard Editor" } },
            { attribute: ":student/status", value: { type: "string", value: "graduated" } },
          ]),
        });
        const history = yield* loadEntityHistory("student:dashboard-editor");
        const triples = yield* Triples;
        const current = yield* triples.entity(EntityId.make("student:dashboard-editor"));
        return { created, updated, history, current };
      }).pipe(Effect.provide(DashboardDemoLayer)),
    );

    expect(result.created).toContain("Created student:dashboard-editor");
    expect(result.updated).toContain("Updated student:dashboard-editor");
    expect(result.history).toHaveLength(2);
    expect(result.history[0]?.changes.some((change) => change.op === "retract")).toBe(true);
    expect(result.history[0]?.changes.some((change) => change.value === "graduated")).toBe(true);
    expect(
      result.current.some(
        (fact) => fact.value.type === "string" && fact.value.value === "graduated",
      ),
    ).toBe(true);
  });

  it("publishes edited config as a new immutable revision and moves live", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const before = yield* loadDashboard;
        const form = before.config.objects.find(
          (object) => object.kind === "form" && object.key === "quiz/bitemporal-facts",
        )!;
        const body = JSON.parse(form.history[0]!.body) as { attrs: Record<string, unknown> };
        const notice = yield* publishConfigChange({
          operation: "edit",
          identity: "form\u0000quiz/bitemporal-facts",
          kind: "form",
          key: "quiz/bitemporal-facts",
          attrs: JSON.stringify({ ...body.attrs, title: "Bitemporal Facts Lab" }),
          refs: JSON.stringify((body as { refs?: unknown }).refs ?? []),
          label: "learning-2026.fall-dashboard-edit",
          targetRef: "live",
        });
        const after = yield* loadDashboard;
        return { before, after, notice };
      }).pipe(Effect.provide(DashboardDemoLayer)),
    );

    expect(result.notice).toContain("moved live");
    expect(result.after.config.releaseCount).toBe(result.before.config.releaseCount + 1);
    expect(result.after.config.label).toBe("learning-2026.fall-dashboard-edit");
    const updated = result.after.config.objects.find(
      (object) => object.kind === "form" && object.key === "quiz/bitemporal-facts",
    );
    expect(updated?.history).toHaveLength(3);
    expect(updated?.history[0]?.body).toContain("Bitemporal Facts Lab");
    expect(result.after.forms[0]?.title).toBe("Bitemporal Facts Lab");
  });

  it("creates and removes config objects through releases and can promote refs", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* publishConfigChange({
          operation: "create",
          kind: "grading-policy",
          key: "grading/standard",
          attrs: JSON.stringify({ passingScore: 70, scale: "percentage" }),
          refs: "[]",
          label: "learning-2026.grading-draft",
          targetRef: "none",
        });
        const config = yield* ConfigStore.ConfigStore;
        const afterCreate = yield* config.load();
        const draft = afterCreate.snapshots.at(-1)!;
        const promoted = yield* moveConfigRef("test", draft.id);
        const testRef = yield* config.resolveRef("test");
        const removed = yield* publishConfigChange({
          operation: "remove",
          identity: "form\u0000quiz/bitemporal-facts",
          kind: "form",
          key: "quiz/bitemporal-facts",
          attrs: "{}",
          refs: "[]",
          label: "learning-2026.no-quiz",
          targetRef: "none",
        });
        const afterRemove = yield* config.load();
        return { created, promoted, removed, draft, testRef, afterRemove };
      }).pipe(Effect.provide(DashboardDemoLayer)),
    );

    expect(result.created).toContain("Published learning-2026.grading-draft");
    expect(result.promoted).toBe("Moved test to learning-2026.grading-draft");
    expect(result.testRef?.id).toBe(result.draft.id);
    expect(result.removed).toContain("Published learning-2026.no-quiz");
    expect(
      result.afterRemove.snapshots
        .at(-1)
        ?.root.children.some(
          (child) => child.node.kind === "form" && child.node.key === "quiz/bitemporal-facts",
        ),
    ).toBe(false);
  });

  it("renders reflected entity attributes as an editable form and clears one attribute", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const data = yield* loadDashboard;
        const page = yield* loadEntityTypePage("QuizSubmission", null, 20);
        const base = {
          ...initialModel,
          data,
          busy: false,
          selectedEntityType: "QuizSubmission" as const,
          selectedEntityId: "submission:leo-bitemporal-facts",
          entityTypePage: page,
        };
        const editing = update(base, Message.RequestedEditEntity());
        const cleared = update(
          editing.model,
          Message.ClearedEntityAttribute({ attribute: ":submission/status" }),
        );
        const saving = update(cleared.model, Message.RequestedSaveEntity());
        const completed = yield* saving.commands![0]!.effect;
        const triples = yield* Triples;
        const current = yield* triples.entity(EntityId.make("submission:leo-bitemporal-facts"));
        return { editing, cleared, completed, current, page };
      }).pipe(Effect.provide(DashboardDemoLayer)),
    );

    expect(result.page.attributes.map((attribute) => attribute.attribute)).toEqual(
      expect.arrayContaining([
        ":submission/student",
        ":submission/quiz",
        ":submission/status",
        ":submission/answers",
      ]),
    );
    expect(result.editing.model.entityEditorFormat).toBe("form");
    expect(result.editing.model.entityAttributeDrafts).toHaveLength(result.page.attributes.length);
    expect(
      result.cleared.model.entityAttributeDrafts.find(
        (draft) => draft.attribute === ":submission/status",
      )?.cleared,
    ).toBe(true);
    expect(result.completed._tag).toBe("SucceededMutation");
    expect(result.current.some((fact) => fact.attribute === ":submission/status")).toBe(false);
    expect(result.current.some((fact) => fact.attribute === ":submission/student")).toBe(true);
  });

  it("finds and selects a correctly typed entity for reference attributes", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        yield* triples.assert({
          entityId: EntityId.make("teacher:grace-hopper"),
          entityType: "Teacher",
          attribute: ":person/name",
          value: string("Grace Hopper"),
        });
        const data = yield* loadDashboard;
        const page = yield* loadEntityTypePage("Course", null, 20);
        const base = {
          ...initialModel,
          data,
          busy: false,
          selectedEntityType: "Course" as const,
          selectedEntityId: "course:data-systems-201",
          entityTypePage: page,
        };
        const editing = update(base, Message.RequestedEditEntity());
        const searched = update(
          editing.model,
          Message.ChangedEntityReferenceSearch({
            attribute: ":course/teacher",
            search: "grace",
          }),
        );
        const selected = update(
          searched.model,
          Message.SelectedEntityReference({
            attribute: ":course/teacher",
            entityId: "teacher:grace-hopper",
          }),
        );
        const saving = update(selected.model, Message.RequestedSaveEntity());
        const completed = yield* saving.commands![0]!.effect;
        const current = yield* triples.entity(EntityId.make("course:data-systems-201"));
        return { editing, searched, selected, completed, current, page };
      }).pipe(Effect.provide(DashboardDemoLayer)),
    );

    const teacherAttribute = result.page.attributes.find(
      (attribute) => attribute.attribute === ":course/teacher",
    );
    expect(teacherAttribute).toMatchObject({
      valueType: "ref",
      referenceTarget: "Teacher",
    });
    scene(
      { update, view },
      given(result.searched.model),
      expectScene(text("Find Teacher")).toExist(),
      expectScene(text("Grace Hopper")).toExist(),
    );
    expect(
      result.selected.model.entityAttributeDrafts.find(
        (draft) => draft.attribute === ":course/teacher",
      ),
    ).toMatchObject({ value: "teacher:grace-hopper", referenceSearch: "" });
    expect(result.completed._tag).toBe("SucceededMutation");
    expect(result.current.find((fact) => fact.attribute === ":course/teacher")?.value).toEqual({
      type: "ref",
      value: "teacher:grace-hopper",
    });
  });
});
