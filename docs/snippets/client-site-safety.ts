import { Effect, Layer } from "effect";
import { EntityId, KvTriples, Triples, type TransactionRecord } from "@triplex-build/triplex";
import { Attribute, ConfigStore, ContentId, EntityType } from "@triplex-build/triplex/config";
import * as Database from "@triplex-build/triplex/database";
import * as Derivation from "@triplex-build/triplex/derivation";

export const MAR_2 = Date.UTC(2026, 2, 2);
const maria = EntityId.make("worker:maria");
const harbor = EntityId.make("site:harbor");
const placement = EntityId.make("placement:maria-harbor");

// #region model
const Site = EntityType.make("Site", {
  name: Attribute.text(":site/name").required(),
});
const Worker = EntityType.make("Worker", {
  name: Attribute.text(":worker/name").required(),
  trainedFor: Attribute.ref(":worker/trained-for", Site).many(),
});
const Placement = EntityType.make("Placement", {
  worker: Attribute.ref(":placement/worker", Worker).required(),
  site: Attribute.ref(":placement/site", Site).required(),
});
const Model = { types: [Site, Worker, Placement] } as const;
// #endregion model

// #region release
const publish = Effect.gen(function* () {
  const config = yield* ConfigStore.ConfigStore;
  return yield* config.commit({
    label: "site-safety-v1",
    objects: yield* EntityType.nodesOf(...Model.types),
    ref: "live",
  });
});
// #endregion release

// #region command
const Client = Database.layer({ schema: Model });
const placeWorker = Effect.gen(function* () {
  const db = yield* Database.Database;
  return yield* db.command(
    {
      actor: "user:dana",
      commandId: `create:${placement}`, // keep this ID on retries
      correlationId: "request:7f3a",
    },
    (tx) => tx.create(Placement, placement, { worker: maria, site: harbor }, { validFrom: MAR_2 }),
  );
});
// #endregion command

// #region ask
const audit = (receipt: TransactionRecord) =>
  Effect.gen(function* () {
    const db = yield* Database.Database;
    const config = yield* ConfigStore.ConfigStore;
    const then = yield* db.asOf({ recordedPosition: receipt.position, validAt: MAR_2 });
    const now = yield* db.asOf({ validAt: MAR_2 });
    return {
      actor: receipt.actor,
      governedBy: !ContentId.isContentId(receipt.configSnapshot)
        ? undefined
        : (yield* config.snapshotById(receipt.configSnapshot))?.label,
      trainedAsKnownThen:
        (yield* then.get(Worker, maria))?.values.trainedFor.includes(harbor) ?? false,
      trainedAsKnownNow:
        (yield* now.get(Worker, maria))?.values.trainedFor.includes(harbor) ?? false,
    };
  });
// #endregion ask

// #region derive
// Derivations use the underlying Triples service and an explicit release.
const openWork = (configSnapshot: string) =>
  Effect.gen(function* () {
    const training = yield* Derivation.make({
      name: "task.site-safety-training",
      query: {
        find: ["?worker", "?site"],
        where: [
          ...Placement.where("?placement", { worker: "?worker", site: "?site" }),
          Worker.not("?worker", { trainedFor: "?site" }),
        ],
      },
      identity: ["?worker", "?site"],
      configSnapshot,
    });
    const { candidates, nextTemporalBoundary } = yield* Derivation.evaluate(
      yield* Triples,
      training,
      { basis: { validAt: MAR_2 } },
    );
    return { open: candidates.map((task) => task.result), recheckAt: nextTemporalBoundary };
  });
// #endregion derive

// #region run
const Store = ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer));
const application = Effect.gen(function* () {
  const release = yield* publish; // deployment step, before client acquisition
  const program = Effect.gen(function* () {
    const db = yield* Database.Database;
    yield* db.command({ actor: "seed", commandId: "seed:site-safety" }, (tx) =>
      Effect.gen(function* () {
        yield* tx.create(Site, harbor, { name: "Harbor" }, { validFrom: MAR_2 });
        yield* tx.create(Worker, maria, { name: "Maria" }, { validFrom: MAR_2 });
      }),
    );
    // #region retry
    const receipt = yield* placeWorker;
    const retry = yield* placeWorker; // original receipt; callback does not run again
    // #endregion retry
    return {
      receipt,
      retry,
      audit: yield* audit(receipt),
      work: yield* openWork(release.snapshot.id),
    };
  });
  return yield* program.pipe(Effect.provide(Client));
});
export const main = application.pipe(Effect.provide(Store));
// #endregion run
