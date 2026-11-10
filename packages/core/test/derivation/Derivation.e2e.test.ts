import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { KvTriples } from "../../src/kv/layers/KvTriplesLive.js";
import { transactSystem } from "../../src/store/systemNamespace.js";
import { Triples } from "../../src/store/Triples.js";
import { ref } from "../../src/Value.js";
import * as Derivation from "../../src/derivation/Derivation.js";
import * as Materialization from "../../src/derivation/Materialization.js";
import * as Overlay from "../../src/derivation/Overlay.js";

const placementFacts = (placement: string, validTo?: number) =>
  [
    {
      entityId: placement,
      entityType: "Placement",
      attribute: ":placement/worker",
      value: ref("worker:maria"),
      validFrom: 100,
      ...(validTo === undefined ? {} : { validTo }),
    },
    {
      entityId: placement,
      entityType: "Placement",
      attribute: ":placement/employer",
      value: ref("employer:acme"),
      validFrom: 100,
      ...(validTo === undefined ? {} : { validTo }),
    },
  ] as const;

const requirementQuery = {
  find: ["?worker", "?scope"],
  where: [
    ["?placement", ":placement/worker", "?worker"],
    ["?placement", ":placement/employer", "?scope"],
  ],
} as const;

const taskQuery = {
  ...requirementQuery,
  where: [...requirementQuery.where, ["not", ["?worker", ":submission/i9", "?scope"]]],
} as const;

describe("content-addressed derivations", () => {
  it.effect(
    "round-trips a materialized commit-position basis and distinguishes different cuts",
    () =>
      Effect.gen(function* () {
        const triples = yield* Triples;
        const written = yield* triples.transact(
          placementFacts("placement:position").map((fact) => ({ op: "assert" as const, ...fact })),
        );
        const definition = yield* Derivation.make({
          name: "position.materialization",
          query: requirementQuery,
          identity: ["?worker", "?scope"],
          configSnapshot: "config:position",
        });
        const basis = { validAt: 150, recordedPosition: written.position };
        yield* Materialization.materialize(triples, definition, { basis });
        const restored = yield* Materialization.current(triples, definition, { basis });
        expect(restored.status).toBe("current");
        expect(restored.basis).toEqual(basis);
        expect(restored.candidates).toHaveLength(1);
        const otherCut = yield* Materialization.current(triples, definition, {
          basis: { ...basis, recordedPosition: written.position + 1 },
        });
        expect(otherCut.status).toBe("stale");
      }).pipe(Effect.provide(KvTriples.layer)),
  );
  it.effect(
    "deduplicates compliance candidates, explains them, and reconciles temporal changes",
    () =>
      Effect.gen(function* () {
        const triples = yield* Triples;
        yield* triples.assertBatch([
          ...placementFacts("placement:one", 180),
          ...placementFacts("placement:two"),
        ]);

        const requirement = yield* Derivation.make({
          name: "require.i9",
          query: requirementQuery,
          identity: ["?worker", "?scope"],
          configSnapshot: "config:staffing-v1",
        });
        const task = yield* Derivation.make({
          name: "task.i9",
          query: taskQuery,
          identity: ["?worker", "?scope"],
          configSnapshot: "config:staffing-v1",
        });
        expect(task.dependencies.attributes).toEqual([
          ":placement/employer",
          ":placement/worker",
          ":submission/i9",
        ]);

        const first = yield* Derivation.evaluate(triples, requirement, {
          basis: { validAt: 150 },
        });
        expect(first.candidates).toHaveLength(1);
        expect(first.candidates[0]).toEqual(
          expect.objectContaining({
            identity: { "?scope": "employer:acme", "?worker": "worker:maria" },
            result: { "?scope": "employer:acme", "?worker": "worker:maria" },
          }),
        );
        expect(first.candidates[0]!.sources).toHaveLength(4);
        expect(first.candidates[0]!.nextTemporalBoundary).toBe(180);
        expect(first.candidates[0]!.sources).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              transactionId: expect.any(String),
              transactionPosition: expect.any(Number),
            }),
          ]),
        );

        const openBeforeSubmission = yield* Derivation.evaluate(triples, task, {
          basis: { validAt: 110 },
        });
        expect(openBeforeSubmission.candidates).toHaveLength(1);

        yield* triples.assert({
          entityId: "worker:maria",
          entityType: "Worker",
          attribute: ":submission/i9",
          value: ref("employer:acme"),
          validFrom: 120,
          validTo: 200,
        });

        const satisfied = yield* Derivation.evaluate(triples, task, {
          basis: { validAt: 150 },
        });
        expect(satisfied.candidates).toEqual([]);
        expect(Derivation.reconcile(openBeforeSubmission.candidates, satisfied.candidates)).toEqual(
          expect.objectContaining({
            added: [],
            removed: openBeforeSubmission.candidates,
            changed: [],
          }),
        );

        const reopened = yield* Derivation.evaluate(triples, task, {
          basis: { validAt: 200 },
        });
        expect(reopened.candidates).toHaveLength(1);

        const afterSupportingFactsExpire = yield* Derivation.evaluate(triples, requirement, {
          basis: { validAt: 180 },
        });
        expect(afterSupportingFactsExpire.candidates[0]!.id).toBe(first.candidates[0]!.id);
        expect(afterSupportingFactsExpire.candidates[0]!.sources).toHaveLength(2);

        yield* triples.assertBatch(placementFacts("placement:three"));
        const withAnotherSource = yield* Derivation.evaluate(triples, requirement, {
          basis: { validAt: 150 },
        });
        expect(withAnotherSource.candidates[0]!.id).toBe(first.candidates[0]!.id);
        expect(withAnotherSource.candidates[0]!.revision).not.toBe(first.candidates[0]!.revision);
        expect(withAnotherSource.candidates[0]!.sources).toHaveLength(6);
        expect(
          Derivation.reconcile(first.candidates, withAnotherSource.candidates).changed,
        ).toHaveLength(1);
      }).pipe(Effect.provide(KvTriples.layer)),
  );

  it.effect("checkpoints candidates durably and reports projection freshness", () =>
    Effect.gen(function* () {
      const triples = yield* Triples;
      yield* triples.assertBatch(placementFacts("placement:one"));
      const task = yield* Derivation.make({
        name: "task.i9",
        query: taskQuery,
        identity: ["?worker", "?scope"],
        configSnapshot: "config:staffing-v1",
      });

      expect(yield* Materialization.current(triples, task, { basis: { validAt: 110 } })).toEqual(
        expect.objectContaining({ status: "unmaterialized", candidates: [] }),
      );

      const first = yield* Materialization.materialize(triples, task, {
        basis: { validAt: 110 },
      });
      expect(first.transaction).toBeDefined();
      expect(first.reconciliation.added).toHaveLength(1);
      expect(yield* Materialization.current(triples, task, { basis: { validAt: 110 } })).toEqual(
        expect.objectContaining({
          status: "current",
          sourcePosition: first.sourcePosition,
          candidates: [expect.objectContaining({ id: first.candidates[0]!.id })],
        }),
      );

      const repeated = yield* Materialization.materialize(triples, task, {
        basis: { validAt: 110 },
      });
      expect(repeated.transaction).toBeUndefined();
      expect(repeated.reconciliation.unchanged).toHaveLength(1);

      // An unrelated transaction advances the global journal but cannot make
      // this dependency-scoped projection stale.
      yield* triples.assert({
        entityId: "note:one",
        entityType: "Note",
        attribute: ":note/body",
        value: { type: "string", value: "unrelated" },
      });
      expect(yield* Materialization.current(triples, task, { basis: { validAt: 110 } })).toEqual(
        expect.objectContaining({ status: "current", sourcePosition: first.sourcePosition }),
      );

      yield* triples.assert({
        entityId: "worker:maria",
        entityType: "Worker",
        attribute: ":submission/i9",
        value: ref("employer:acme"),
        validFrom: 120,
        validTo: 200,
      });
      const beforeEffectiveDate = yield* Derivation.evaluate(triples, task, {
        basis: { validAt: 110 },
      });
      expect(beforeEffectiveDate.candidates).toHaveLength(1);
      expect(beforeEffectiveDate.nextTemporalBoundary).toBe(120);
      const stale = yield* Materialization.current(triples, task, { basis: { validAt: 150 } });
      expect(stale).toEqual(
        expect.objectContaining({
          status: "stale",
          candidates: [expect.objectContaining({ id: first.candidates[0]!.id })],
        }),
      );
      expect(stale.currentPosition).toBeGreaterThan(first.sourcePosition);

      const satisfied = yield* Materialization.materialize(triples, task, {
        basis: { validAt: 150 },
      });
      expect(satisfied.candidates).toEqual([]);
      expect(satisfied.nextTemporalBoundary).toBe(200);
      expect(satisfied.reconciliation.removed).toHaveLength(1);
      expect(yield* Materialization.current(triples, task, { basis: { validAt: 150 } })).toEqual(
        expect.objectContaining({
          status: "current",
          candidates: [],
          nextTemporalBoundary: 200,
        }),
      );
      const persistedWakeup = yield* triples.match({
        entityId: Materialization.entityId.run(satisfied.id),
        attribute: Materialization.System.attribute.nextTemporalBoundary,
      });
      expect(persistedWakeup[0]?.value).toEqual({ type: "number", value: 200 });

      // Valid time alone makes the pinned checkpoint stale. Re-evaluation at
      // expiry reopens the obligation without a new operational transaction.
      expect(yield* Materialization.current(triples, task, { basis: { validAt: 200 } })).toEqual(
        expect.objectContaining({ status: "stale", candidates: [] }),
      );
      const reopened = yield* Materialization.materialize(triples, task, {
        basis: { validAt: 200 },
      });
      expect(reopened.reconciliation.added).toHaveLength(1);
      expect(reopened.nextTemporalBoundary).toBeUndefined();

      const cancelledFutureEvidence = yield* triples.assert({
        entityId: "worker:maria",
        entityType: "Worker",
        attribute: ":submission/i9",
        value: ref("employer:acme"),
        validFrom: 300,
        validTo: 400,
      });
      expect(
        (yield* Derivation.evaluate(triples, task, { basis: { validAt: 200 } }))
          .nextTemporalBoundary,
      ).toBe(300);
      yield* triples.retract(cancelledFutureEvidence.id);
      expect(
        (yield* Derivation.evaluate(triples, task, { basis: { validAt: 200 } }))
          .nextTemporalBoundary,
      ).toBeUndefined();

      // Deploying another immutable definition keeps logical candidate IDs
      // stable while producing a changed revision and a new durable run.
      const taskV2 = yield* Derivation.make({
        name: "task.i9",
        query: taskQuery,
        identity: ["?worker", "?scope"],
        configSnapshot: "config:staffing-v2",
      });
      expect(yield* Materialization.current(triples, taskV2, { basis: { validAt: 200 } })).toEqual(
        expect.objectContaining({ status: "stale" }),
      );
      const redeployed = yield* Materialization.materialize(triples, taskV2, {
        basis: { validAt: 200 },
      });
      expect(redeployed.candidates[0]!.id).toBe(reopened.candidates[0]!.id);
      expect(redeployed.reconciliation.changed).toHaveLength(1);
      expect(
        (yield* triples.query(Materialization.runsQuery("task.i9"))).results.length,
      ).toBeGreaterThan(1);

      const candidateEntity = Materialization.entityId.candidate(
        redeployed.candidates[0]!.revision,
      );
      const body = (yield* triples.match({
        entityId: candidateEntity,
        attribute: Materialization.System.attribute.candidateBody,
      }))[0]!;
      expect(body.value.type).toBe("json");
      const stored =
        body.value.type === "json" ? (body.value.value as Record<string, unknown>) : {};
      yield* transactSystem(triples, [
        { op: "retract", id: body.id },
        {
          op: "assert",
          entityId: candidateEntity,
          entityType: Materialization.System.entityType.candidate,
          attribute: Materialization.System.attribute.candidateBody,
          value: {
            type: "json",
            value: { ...stored, result: { "?scope": "employer:other" } },
          },
        },
      ]);
      const corrupt = yield* Materialization.current(triples, taskV2, {
        basis: { validAt: 200 },
      }).pipe(Effect.flip);
      expect(corrupt._tag).toBe("CorruptDerivationMaterializationError");
    }).pipe(Effect.provide(KvTriples.layer)),
  );

  it.effect("plans collect and reuse outcomes without mutating durable facts", () =>
    Effect.gen(function* () {
      const triples = yield* Triples;
      const placement = yield* triples.assertBatch(placementFacts("placement:one"));
      const task = yield* Derivation.make({
        name: "task.i9",
        query: taskQuery,
        identity: ["?worker", "?scope"],
        configSnapshot: "config:staffing-v1",
      });
      const before = yield* triples.transactions({ after: 0, limit: 1_000 });

      const baseline = yield* Derivation.evaluate(triples, task, { basis: { validAt: 150 } });
      expect(baseline.candidates).toHaveLength(1);

      // A hypothetical reusable submission satisfies the existing Acme task.
      const reuse = yield* Overlay.evaluateOverlay(triples, task, {
        basis: { validAt: 150 },
        overlay: {
          assertions: [
            {
              entityId: "worker:maria",
              entityType: "Worker",
              attribute: ":submission/i9",
              value: ref("employer:acme"),
              validTo: 200,
            },
          ],
        },
      });
      expect(reuse.candidates).toEqual([]);
      expect(reuse.nextTemporalBoundary).toBe(200);

      // A proposed placement in a new scope produces a second collect task.
      const collect = yield* Overlay.evaluateOverlay(triples, task, {
        basis: { validAt: 150 },
        overlay: {
          assertions: placementFacts("placement:proposed").map((fact) => ({
            ...fact,
            value: fact.attribute === ":placement/employer" ? ref("employer:globex") : fact.value,
          })),
        },
      });
      expect(collect.candidates).toHaveLength(2);
      const globex = collect.candidates.find(
        (candidate) => candidate.identity["?scope"] === "employer:globex",
      );
      expect(globex?.sources).toEqual([
        expect.objectContaining({
          hypothetical: true,
          hypotheticalContentId: expect.stringMatching(/^sha256-/),
        }),
        expect.objectContaining({
          hypothetical: true,
          hypotheticalContentId: expect.stringMatching(/^sha256-/),
        }),
      ]);

      // Retractions can remove visible base facts from the same read-only view.
      const withoutWorkerEdge = yield* Overlay.evaluateOverlay(triples, task, {
        basis: { validAt: 150 },
        overlay: { retractions: [placement[0]!.id] },
      });
      expect(withoutWorkerEdge.candidates).toEqual([]);

      const invalid = yield* Overlay.evaluateOverlay(triples, task, {
        basis: { validAt: 150 },
        overlay: { retractions: ["01INVALIDOVERLAYTRIPLEID000"] },
      }).pipe(Effect.flip);
      expect(invalid._tag).toBe("InvalidDerivationOverlayError");

      const dynamic = yield* Derivation.make({
        name: "dynamic.preview",
        query: {
          find: ["?entity", "?attribute", "?value"],
          where: [["?entity", "?attribute", "?value"]],
        },
        identity: ["?entity", "?attribute", "?value"],
        configSnapshot: "config:staffing-v1",
      });
      const unsupported = yield* Overlay.evaluateOverlay(triples, dynamic, {
        basis: { validAt: 150 },
        overlay: {},
      }).pipe(Effect.flip);
      expect(unsupported._tag).toBe("UnsupportedDerivationOverlayDefinitionError");

      // Every hypothetical write occurred in a private in-memory store.
      const after = yield* triples.transactions({ after: 0, limit: 1_000 });
      expect(after.transactions.map((transaction) => transaction.txId)).toEqual(
        before.transactions.map((transaction) => transaction.txId),
      );
      expect(yield* triples.match({ entityId: "placement:proposed" })).toEqual([]);
      expect(
        (yield* Derivation.evaluate(triples, task, { basis: { validAt: 150 } })).candidates,
      ).toHaveLength(1);
    }).pipe(Effect.provide(KvTriples.layer)),
  );
});
