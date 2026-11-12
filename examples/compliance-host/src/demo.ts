import { Clock, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { EntityId, KvTriples, Triples } from "@triplex-build/triplex";
import { Attribute, ConfigStore, EntityType } from "@triplex-build/triplex/config";
import * as Database from "@triplex-build/triplex/database";
import * as Derivation from "@triplex-build/triplex/derivation";
import * as Runner from "@triplex-build/triplex/runner";
import { DatabaseScope } from "@triplex-build/triplex/runtime";

const Placement = EntityType.make("Placement", {
  worker: Attribute.text(":placement/worker").required(),
  site: Attribute.text(":placement/site").required(),
});
const Worker = EntityType.make("Worker", {
  training: Attribute.text(":evidence/site-safety"),
});
// The complete occurrence model is published, including every audit field.
const Requirement = EntityType.make("DemoRequirementOccurrence", {
  candidate: Attribute.text(":requirement/candidate").required(),
  occurrence: Attribute.number(":requirement/occurrence").required(),
  status: Attribute.text(":requirement/status").required(),
  revision: Attribute.text(":requirement/candidate-revision").required(),
  definition: Attribute.text(":requirement/definition").required(),
  configSnapshot: Attribute.text(":requirement/config-snapshot").required(),
  run: Attribute.text(":requirement/materialization-run").required(),
  sourcePosition: Attribute.number(":requirement/source-position").required(),
  openedAt: Attribute.instant(":requirement/opened-at").required(),
  closedAt: Attribute.instant(":requirement/closed-at"),
});
const model = { types: [Placement, Worker, Requirement] } as const;
const worker = EntityId.make("worker:maria");
const site = "site:harbor";
const ensure = (condition: unknown, message: string) => {
  if (!condition) throw new Error(`Demo verification failed: ${message}`);
};

const occurrenceNumber = (value: unknown): number => {
  if (typeof value !== "number") throw new Error("Occurrence number is not open numeric data");
  return value;
};

const application = Effect.gen(function* () {
  const config = yield* ConfigStore.ConfigStore;
  const release = yield* config.commit({
    label: "safety-2026.1",
    objects: [...(yield* EntityType.nodesOf(...model.types)), ...(yield* Runner.schema)],
    ref: "live",
  });
  const definition = yield* Derivation.make({
    name: "task.site-safety-training",
    query: {
      find: ["?worker", "?site"],
      where: [
        ["?placement", Placement.worker.key, "?worker"],
        ["?placement", Placement.site.key, "?site"],
        ["not", ["?worker", Worker.training.key, "?site"]],
      ],
    },
    identity: ["?worker", "?site"],
    configSnapshot: release.snapshot.id,
  });
  return yield* Effect.gen(function* () {
    const db = yield* Database.Database;
    const triples = yield* Triples;
    const occurrences = () => db.list(Requirement, { limit: 100 });
    const prior = (candidate: string) =>
      occurrences().pipe(
        Effect.map((page) =>
          page.entities
            .filter((e) => e.values.candidate === candidate)
            .sort(
              (a, b) =>
                occurrenceNumber(a.values.occurrence) - occurrenceNumber(b.values.occurrence),
            ),
        ),
      );
    const meta = (
      delivery: Runner.Delivery,
      kind: "added" | "removed" | "changed",
      candidate: Derivation.Candidate,
    ) => ({
      actor: "demo/requirement-reconciler",
      commandId: delivery.commandId(kind, candidate.id),
      correlationId: delivery.batchId,
    });
    const openRequirement = (candidate: Derivation.Candidate, delivery: Runner.Delivery) =>
      db.command(meta(delivery, "added", candidate), (tx) =>
        Effect.gen(function* () {
          const history = yield* prior(candidate.id);
          for (const item of history) yield* tx.get(Requirement, item.entityId);
          if (history.some((item) => item.values.status === "open")) return;
          const occurrence = occurrenceNumber(history.at(-1)?.values.occurrence ?? 0) + 1;
          yield* tx.create(
            Requirement,
            EntityId.make(`requirement:${candidate.id}:${occurrence}`),
            {
              candidate: candidate.id,
              occurrence,
              status: "open",
              revision: candidate.revision,
              definition: delivery.definitionId,
              configSnapshot: delivery.configSnapshot,
              run: delivery.runId,
              sourcePosition: delivery.sourcePosition,
              openedAt: delivery.basis.validAt,
            },
            { validFrom: 0 },
          );
        }),
      );
    const editRequirement = (
      candidate: Derivation.Candidate,
      delivery: Runner.Delivery,
      kind: "removed" | "changed",
    ) =>
      db.command(meta(delivery, kind, candidate), (tx) =>
        Effect.gen(function* () {
          const open = (yield* prior(candidate.id)).findLast(
            (item) => item.values.status === "open",
          );
          if (!open) return;
          yield* tx.get(Requirement, open.entityId);
          const rows = yield* triples.liveFacts(open.entityId);
          const attribute = kind === "removed" ? Requirement.status.key : Requirement.revision.key;
          const row = rows.find((row) => row.attribute === attribute);
          ensure(row, "open occurrence must have status and revision");
          const fact = yield* tx.fact(Requirement, row!.id);
          if (kind === "removed") {
            yield* tx.correct(Requirement, fact, { status: "satisfied" });
            yield* tx.put(
              Requirement,
              open.entityId,
              { closedAt: delivery.basis.validAt },
              { validFrom: 0 },
            );
          } else yield* tx.correct(Requirement, fact, { revision: candidate.revision });
        }),
      );
    const delivered: Runner.Delivery[] = [];
    const handle = yield* Runner.start(
      [
        {
          key: "site-safety",
          definition,
          onDiff: (delivery) =>
            Effect.gen(function* () {
              for (const c of delivery.diff.added) yield* openRequirement(c, delivery);
              for (const c of delivery.diff.removed) yield* editRequirement(c, delivery, "removed");
              for (const { after } of delivery.diff.changed)
                yield* editRequirement(after, delivery, "changed");
              delivered.push(delivery);
            }),
        },
      ],
      { scope: DatabaseScope.test("compliance"), id: "compliance", idleCheckMs: 1 },
    );
    // Deterministic scenario harness: the application above contains only domain handlers.
    const waitFor = (count: number) =>
      Effect.gen(function* () {
        for (let i = 0; i < 1000; i++) {
          if (
            delivered.length >= count &&
            (yield* handle.status).registrations[0]!.pending === null
          )
            return;
          yield* Effect.raceFirst(Effect.yieldNow, handle.await);
          yield* TestClock.adjust(1);
        }
        throw new Error(
          `Runner did not deliver scenario transition ${count}: ${JSON.stringify(yield* handle.status)}`,
        );
      });
    yield* db.command({ actor: "demo/placement-api", commandId: "placement:one" }, (tx) =>
      tx.create(Placement, EntityId.make("placement:one"), { worker, site }, { validFrom: 100 }),
    );
    yield* waitFor(1);
    ensure(
      (yield* occurrences()).entities[0]?.values.status === "open",
      "placement opens occurrence 1",
    );
    const preview = yield* Derivation.Overlay.evaluateOverlay(triples, definition, {
      basis: { validAt: 150 },
      overlay: {
        assertions: [
          {
            entityId: worker,
            entityType: "Worker",
            attribute: Worker.training.key,
            value: Worker.training.definition.encode(site),
            validFrom: 120,
            validTo: 200,
          },
        ],
      },
    });
    ensure(
      preview.candidates.length === 0 && preview.nextTemporalBoundary === 200,
      "read-only preview reuses expiring evidence",
    );
    ensure(
      (yield* occurrences()).entities[0]?.values.status === "open",
      "preview leaves durable work open",
    );
    yield* TestClock.setTime(150);
    yield* db.command({ actor: "demo/evidence-api", commandId: "training:maria:harbor" }, (tx) =>
      tx.put(Worker, worker, { training: site }, { validFrom: 120, validTo: 200 }),
    );
    yield* waitFor(2);
    ensure(
      (yield* occurrences()).entities[0]?.values.status === "satisfied",
      "evidence satisfies occurrence 1",
    );
    ensure(
      (yield* handle.status).registrations[0]!.nextDeadline === 200,
      "empty evaluation retains expiry",
    );
    yield* TestClock.setTime(199);
    ensure(delivered.length === 2, "expiry does not fire early");
    yield* TestClock.setTime(200);
    yield* waitFor(3);
    const history = [...(yield* occurrences()).entities].sort(
      (a, b) => occurrenceNumber(a.values.occurrence) - occurrenceNumber(b.values.occurrence),
    );
    ensure(
      history.length === 2 &&
        history[0]!.values.status === "satisfied" &&
        history[1]!.values.status === "open",
      "open → satisfied → reopened",
    );
    ensure(
      delivered[0]!.batchId !== delivered[2]!.batchId,
      "expiry creates a new occurrence identity",
    );
    const status = yield* handle.status;
    yield* handle.stop;
    return {
      release: release.snapshot.id,
      definition: definition.id,
      consumerPosition: status.deliveredPosition,
      previewCandidates: preview.candidates.length,
      occurrences: history.map((e) => e.values),
    };
  }).pipe(Effect.provide(Database.layer({ schema: model })));
});
const HostLayer = ConfigStore.layer.pipe(
  Layer.provideMerge(KvTriples.layerWithClock(Clock.currentTimeMillis)),
);
const result = await Effect.runPromise(
  Effect.gen(function* () {
    yield* TestClock.setTime(110);
    return yield* application;
  }).pipe(Effect.scoped, Effect.provide(HostLayer), Effect.provide(TestClock.layer())),
);
console.log("Triplex compliance host demo", result);
