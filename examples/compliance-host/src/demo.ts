import { Effect, Layer } from "effect";

import {
  EntityId,
  KvTriples,
  Triples,
  datetime,
  number,
  ref,
  string,
  type TransactOp,
  type Triple,
} from "@triplex-build/triplex";
import {
  Attribute,
  ConfigNode,
  ConfigStore,
  EntityType,
  GraphConstraint,
  TypeExpr,
} from "@triplex-build/triplex/config";
import * as Derivation from "@triplex-build/triplex/derivation";
import { ConsumerCheckpoint } from "@triplex-build/triplex/operational";

const PLACEMENT_WORKER = ":placement/worker";
const PLACEMENT_SITE = ":placement/site";
const TRAINING_EVIDENCE = ":evidence/site-safety";

const Requirement = {
  entityType: "DemoRequirementOccurrence",
  attribute: {
    candidate: ":requirement/candidate",
    occurrence: ":requirement/occurrence",
    status: ":requirement/status",
    revision: ":requirement/candidate-revision",
    definition: ":requirement/definition",
    configSnapshot: ":requirement/config-snapshot",
    materializationRun: ":requirement/materialization-run",
    sourcePosition: ":requirement/source-position",
    openedAt: ":requirement/opened-at",
    closedAt: ":requirement/closed-at",
  },
} as const;

const RequirementStatus = Attribute.text(Requirement.attribute.status);
const RequirementSchema = EntityType.make(Requirement.entityType, {
  attributes: {
    status: Attribute.use(RequirementStatus, { required: true }),
  },
});

interface RequirementOccurrence {
  readonly entityId: EntityId;
  readonly candidate: string;
  readonly occurrence: number;
  readonly status: string;
  readonly revision: string;
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Demo verification failed: ${message}`);
}

const scalar = (triple: Triple | undefined): string | number | undefined => {
  if (!triple) return undefined;
  switch (triple.value.type) {
    case "string":
    case "ref":
    case "number":
    case "datetime":
      return triple.value.value;
    default:
      return undefined;
  }
};

const latestAt = (rows: readonly Triple[], attribute: string): Triple | undefined =>
  rows
    .filter((row) => row.attribute === attribute)
    .sort(
      (left, right) => right.recordedAt - left.recordedAt || right.id.localeCompare(left.id),
    )[0];

const groupByEntity = (rows: readonly Triple[]): ReadonlyMap<EntityId, readonly Triple[]> => {
  const grouped = new Map<EntityId, Triple[]>();
  for (const row of rows) {
    const entity = grouped.get(row.entityId) ?? [];
    entity.push(row);
    grouped.set(row.entityId, entity);
  }
  return grouped;
};

const program = Effect.gen(function* () {
  const triples = yield* Triples;
  const config = yield* ConfigStore.ConfigStore;
  const placementId = EntityId.make("placement:one");
  const workerId = EntityId.make("worker:maria");
  const siteId = EntityId.make("site:harbor");

  // The application compiler emits independently identified, typed config
  // nodes. References express deploy impact without merging config and facts.
  const Descriptor = TypeExpr.struct({
    label: TypeExpr.required(TypeExpr.text),
    version: TypeExpr.required(TypeExpr.number),
  });
  const node = (input: {
    readonly kind: string;
    readonly key: string;
    readonly label: string;
    readonly refs?: readonly ConfigNode.ConfigRef[];
  }) =>
    ConfigNode.makeTyped({
      kind: input.kind,
      key: input.key,
      type: Descriptor,
      attrs: { label: input.label, version: 1 },
      ...(input.refs === undefined ? {} : { refs: input.refs }),
    });

  const placementWorker = yield* node({
    kind: "attribute",
    key: PLACEMENT_WORKER,
    label: "Placement worker",
  });
  const placementSite = yield* node({
    kind: "attribute",
    key: PLACEMENT_SITE,
    label: "Placement site",
  });
  const evidence = yield* node({
    kind: "attribute",
    key: TRAINING_EVIDENCE,
    label: "Valid site-safety training",
  });
  const placementType = yield* node({
    kind: "entity-type",
    key: "Placement",
    label: "Placement",
    refs: [
      { rel: "uses", kind: "attribute", key: PLACEMENT_WORKER },
      { rel: "uses", kind: "attribute", key: PLACEMENT_SITE },
    ],
  });
  const trainingForm = yield* node({
    kind: "form",
    key: "site-safety-training",
    label: "Site safety training",
    refs: [{ rel: "writes", kind: "attribute", key: TRAINING_EVIDENCE }],
  });
  const policy = yield* node({
    kind: "policy",
    key: "site-safety-required",
    label: "Workers need current safety training for each site",
    refs: [
      { rel: "reads", kind: "entity-type", key: "Placement" },
      { rel: "reads", kind: "attribute", key: TRAINING_EVIDENCE },
      { rel: "collects", kind: "form", key: "site-safety-training" },
    ],
  });
  const routine = yield* node({
    kind: "routine",
    key: "reconcile-site-safety",
    label: "Reconcile site-safety work",
    refs: [
      { rel: "evaluates", kind: "policy", key: "site-safety-required" },
      { rel: "opens", kind: "form", key: "site-safety-training" },
    ],
  });
  const requirementNodes = yield* RequirementSchema.nodes;

  const release = yield* config.commit({
    label: "safety-2026.1",
    objects: [
      placementWorker,
      placementSite,
      evidence,
      placementType,
      trainingForm,
      policy,
      routine,
      ...requirementNodes,
    ],
    ref: "live",
  });
  const enforcement = GraphConstraint.enforcement(RequirementSchema.constraints);

  const definition = yield* Derivation.make({
    name: "task.site-safety-training",
    query: {
      find: ["?worker", "?site"],
      where: [
        ["?placement", PLACEMENT_WORKER, "?worker"],
        ["?placement", PLACEMENT_SITE, "?site"],
        ["not", ["?worker", TRAINING_EVIDENCE, "?site"]],
      ],
    },
    identity: ["?worker", "?site"],
    configSnapshot: release.snapshot.id,
  });

  const loadOccurrences = (candidate?: string) =>
    triples.match({ entityType: Requirement.entityType }).pipe(
      Effect.map((rows) =>
        [...groupByEntity(rows)].flatMap(([entityId, entityRows]) => {
          const candidateValue = scalar(latestAt(entityRows, Requirement.attribute.candidate));
          const occurrence = scalar(latestAt(entityRows, Requirement.attribute.occurrence));
          const status = scalar(latestAt(entityRows, Requirement.attribute.status));
          const revision = scalar(latestAt(entityRows, Requirement.attribute.revision));
          if (
            typeof candidateValue !== "string" ||
            typeof occurrence !== "number" ||
            typeof status !== "string" ||
            typeof revision !== "string" ||
            (candidate !== undefined && candidateValue !== candidate)
          ) {
            return [];
          }
          return [
            {
              entityId,
              candidate: candidateValue,
              occurrence,
              status,
              revision,
            } satisfies RequirementOccurrence,
          ];
        }),
      ),
    );

  const reconcile = (run: Derivation.Materialization.MaterializationRun, validAt: number) =>
    Effect.gen(function* () {
      for (const candidate of run.reconciliation.added) {
        const prior = yield* loadOccurrences(candidate.id);
        if (prior.some((occurrence) => occurrence.status === "open")) continue;
        const occurrence = Math.max(0, ...prior.map((item) => item.occurrence)) + 1;
        const entityId = EntityId.make(`requirement:${candidate.id}:${occurrence}`);
        const operations: readonly TransactOp[] = [
          {
            op: "assert",
            entityId,
            entityType: Requirement.entityType,
            attribute: Requirement.attribute.candidate,
            value: string(candidate.id),
          },
          {
            op: "assert",
            entityId,
            entityType: Requirement.entityType,
            attribute: Requirement.attribute.occurrence,
            value: number(occurrence),
          },
          {
            op: "assert",
            entityId,
            entityType: Requirement.entityType,
            attribute: Requirement.attribute.status,
            value: string("open"),
          },
          {
            op: "assert",
            entityId,
            entityType: Requirement.entityType,
            attribute: Requirement.attribute.revision,
            value: string(candidate.revision),
          },
          {
            op: "assert",
            entityId,
            entityType: Requirement.entityType,
            attribute: Requirement.attribute.definition,
            value: string(definition.id),
          },
          {
            op: "assert",
            entityId,
            entityType: Requirement.entityType,
            attribute: Requirement.attribute.configSnapshot,
            value: string(definition.configSnapshot),
          },
          {
            op: "assert",
            entityId,
            entityType: Requirement.entityType,
            attribute: Requirement.attribute.materializationRun,
            value: string(run.id),
          },
          {
            op: "assert",
            entityId,
            entityType: Requirement.entityType,
            attribute: Requirement.attribute.sourcePosition,
            value: number(run.sourcePosition),
          },
          {
            op: "assert",
            entityId,
            entityType: Requirement.entityType,
            attribute: Requirement.attribute.openedAt,
            value: datetime(validAt),
          },
        ];
        yield* triples.transact(operations, {
          actor: "demo/requirement-reconciler",
          commandId: `requirement:${run.id}:open:${candidate.id}`,
          correlationId: run.id,
          configSnapshot: definition.configSnapshot,
          enforce: enforcement,
        });
      }

      for (const candidate of run.reconciliation.removed) {
        const open = (yield* loadOccurrences(candidate.id))
          .filter((occurrence) => occurrence.status === "open")
          .sort((left, right) => right.occurrence - left.occurrence)[0];
        if (!open) continue;
        const rows = yield* triples.match({ entityId: open.entityId });
        const status = latestAt(rows, Requirement.attribute.status);
        if (!status) continue;
        yield* triples.transact(
          [
            { op: "retract", id: status.id },
            {
              op: "assert",
              entityId: open.entityId,
              entityType: Requirement.entityType,
              attribute: Requirement.attribute.status,
              value: string("satisfied"),
              // This replaces the recorded value for the same business-time
              // interval; the journal retains the status transition.
              validFrom: status.validFrom,
            },
            {
              op: "assert",
              entityId: open.entityId,
              entityType: Requirement.entityType,
              attribute: Requirement.attribute.closedAt,
              value: datetime(validAt),
            },
          ],
          {
            actor: "demo/requirement-reconciler",
            commandId: `requirement:${run.id}:satisfy:${candidate.id}`,
            correlationId: run.id,
            configSnapshot: definition.configSnapshot,
            enforce: enforcement,
            preconditions: [{ _tag: "TripleLive", id: status.id }],
          },
        );
      }

      for (const change of run.reconciliation.changed) {
        const open = (yield* loadOccurrences(change.after.id)).find(
          (occurrence) => occurrence.status === "open",
        );
        if (!open || open.revision === change.after.revision) continue;
        const rows = yield* triples.match({ entityId: open.entityId });
        const revision = latestAt(rows, Requirement.attribute.revision);
        if (!revision) continue;
        yield* triples.transact(
          [
            { op: "retract", id: revision.id },
            {
              op: "assert",
              entityId: open.entityId,
              entityType: Requirement.entityType,
              attribute: Requirement.attribute.revision,
              value: string(change.after.revision),
              validFrom: revision.validFrom,
            },
          ],
          {
            actor: "demo/requirement-reconciler",
            commandId: `requirement:${run.id}:revise:${change.after.id}`,
            correlationId: run.id,
            configSnapshot: definition.configSnapshot,
            enforce: enforcement,
            preconditions: [{ _tag: "TripleLive", id: revision.id }],
          },
        );
      }
    });

  // Timer delivery remains host-owned. The feed cursor itself is a durable
  // Triplex fact with optimistic concurrency.
  const consumer = "demo/site-safety-materializer/v1";
  const scheduled = new Map<string, number>();

  const materializeAt = (validAt: number) =>
    Effect.gen(function* () {
      const run = yield* Derivation.Materialization.materialize(triples, definition, {
        basis: { validAt },
      });
      yield* reconcile(run, validAt);
      if (run.nextTemporalBoundary === undefined) scheduled.delete(definition.id);
      else scheduled.set(definition.id, run.nextTemporalBoundary);
      return run;
    });

  const consumeTransactions = (validAt: number) =>
    Effect.gen(function* () {
      const checkpoint = yield* ConsumerCheckpoint.get(triples, consumer);
      const expectedPosition = checkpoint?.position ?? 0;
      let cursor = expectedPosition;
      let relevant = false;
      while (true) {
        const page = yield* triples.transactions({ after: cursor, limit: 100 });
        relevant ||= page.transactions.some((transaction) =>
          transaction.changes.some((change) =>
            definition.dependencies.attributes.includes(change.attribute),
          ),
        );
        if (page.next !== undefined) cursor = page.next;
        if (page.transactions.length < 100 || page.next === undefined) break;
      }
      const run = relevant ? yield* materializeAt(validAt) : undefined;
      if (cursor > expectedPosition) {
        yield* ConsumerCheckpoint.advance(triples, {
          consumer,
          expectedPosition,
          nextPosition: cursor,
          meta: { actor: "demo/transaction-consumer" },
        });
      }
      return run;
    });

  const runDueWakeups = (validAt: number) =>
    Effect.gen(function* () {
      const due = [...scheduled].filter(([, at]) => at <= validAt);
      for (const [definitionId] of due) {
        scheduled.delete(definitionId);
        if (definitionId === definition.id) yield* materializeAt(validAt);
      }
      return due.length;
    });

  // 1. A source command creates a placement. The host feed consumer catches
  // up and opens occurrence 1 from the added derivation candidate.
  yield* triples.transact(
    [
      {
        op: "assert",
        entityId: placementId,
        entityType: "Placement",
        attribute: PLACEMENT_WORKER,
        value: ref(workerId),
        validFrom: 100,
      },
      {
        op: "assert",
        entityId: placementId,
        entityType: "Placement",
        attribute: PLACEMENT_SITE,
        value: ref(siteId),
        validFrom: 100,
      },
    ],
    {
      actor: "demo/placement-api",
      commandId: "placement:create:one",
      correlationId: "demo:placement-one",
      configSnapshot: release.snapshot.id,
      enforce: enforcement,
    },
  );
  const opened = yield* consumeTransactions(110);
  ensure(opened?.reconciliation.added.length === 1, "placement should open one requirement");

  // 2. A planner previews reusable evidence without mutating facts, work, the
  // transaction journal, or the scheduler.
  const preview = yield* Derivation.Overlay.evaluateOverlay(triples, definition, {
    basis: { validAt: 150 },
    overlay: {
      assertions: [
        {
          entityId: workerId,
          entityType: "Worker",
          attribute: TRAINING_EVIDENCE,
          value: ref(siteId),
          validFrom: 120,
          validTo: 200,
        },
      ],
    },
  });
  ensure(preview.candidates.length === 0, "hypothetical evidence should satisfy the task");
  ensure(preview.nextTemporalBoundary === 200, "preview should expose evidence expiry");
  ensure((yield* loadOccurrences())[0]?.status === "open", "preview must not close durable work");

  // 3. The real evidence command closes occurrence 1. The zero-candidate run
  // still persists validTo=200 as its next temporal wakeup.
  yield* triples.transact(
    [
      {
        op: "assert",
        entityId: workerId,
        entityType: "Worker",
        attribute: TRAINING_EVIDENCE,
        value: ref(siteId),
        validFrom: 120,
        validTo: 200,
      },
    ],
    {
      actor: "demo/evidence-api",
      commandId: "training:submit:maria:harbor",
      causationId: "placement:create:one",
      correlationId: "demo:placement-one",
      configSnapshot: release.snapshot.id,
      enforce: enforcement,
    },
  );
  const satisfied = yield* consumeTransactions(150);
  ensure(satisfied?.candidates.length === 0, "valid evidence should suppress the task");
  ensure(scheduled.get(definition.id) === 200, "host should schedule the expiry boundary");
  ensure((yield* loadOccurrences())[0]?.status === "satisfied", "occurrence 1 should close");

  // 4. No source transaction happens at expiry. Timer delivery invokes the
  // materializer at 200, and the host opens occurrence 2 while preserving 1.
  ensure((yield* runDueWakeups(199)) === 0, "scheduler must not fire early");
  ensure((yield* runDueWakeups(200)) === 1, "scheduler should fire at evidence expiry");
  yield* consumeTransactions(200); // advance past the host's own projection writes

  const occurrences = (yield* loadOccurrences()).sort(
    (left, right) => left.occurrence - right.occurrence,
  );
  ensure(occurrences.length === 2, "expiry should retain occurrence 1 and open occurrence 2");
  ensure(occurrences[0]?.status === "satisfied", "occurrence 1 history must remain satisfied");
  ensure(occurrences[1]?.status === "open", "occurrence 2 should be open after expiry");
  ensure(scheduled.size === 0, "there should be no boundary after the evidence has expired");

  const queryableWork = yield* triples.query({
    find: ["?requirement", "?occurrence", "?status"],
    where: [
      ["?requirement", Requirement.attribute.occurrence, "?occurrence"],
      ["?requirement", Requirement.attribute.status, "?status"],
    ],
  });
  ensure(queryableWork.results.length === 2, "requirement history should be queryable by Datalog");

  const journal = yield* triples.transactions({ after: 0, limit: 1_000 });
  const reconcilerTransactions = journal.transactions.filter(
    (transaction) => transaction.actor === "demo/requirement-reconciler",
  );
  ensure(reconcilerTransactions.length === 3, "open, satisfy, and reopen must be auditable");
  const consumerCheckpoint = yield* ConsumerCheckpoint.get(triples, consumer);
  ensure(consumerCheckpoint !== null, "the transaction consumer must persist its checkpoint");

  return {
    release: release.snapshot.id,
    definition: definition.id,
    consumerPosition: consumerCheckpoint.position,
    previewCandidates: preview.candidates.length,
    occurrences,
    reconcilerTransactions: reconcilerTransactions.map((transaction) => ({
      position: transaction.position,
      commandId: transaction.commandId,
    })),
  };
});

const HostLayer = ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer));
const result = await Effect.runPromise(program.pipe(Effect.provide(HostLayer)));

console.log("Triplex compliance host demo");
console.log("  config release      ", result.release);
console.log("  derivation          ", result.definition);
console.log("  preview candidates  ", result.previewCandidates, "(read-only evidence reuse)");
console.log("  consumer position   ", result.consumerPosition);
console.log(
  "  requirement history",
  result.occurrences.map((item) => `#${item.occurrence} ${item.status}`).join(" -> "),
);
console.log("  reconciler audit    ", result.reconcilerTransactions);
