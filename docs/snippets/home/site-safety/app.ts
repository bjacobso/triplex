/**
 * The homepage site-safety application, top to bottom: model, rules, a command,
 * audit questions, derived work, storage, and HTTP. The homepage shows each
 * region in order, and `run.ts` executes it in CI to produce every output.
 */
import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { EntityId, KvTriples, Triples, type TemporalBasis } from "@triplex-build/triplex";
import {
  Attribute,
  ConfigStore,
  ContentId,
  EntityType,
  GraphConstraint,
  type InMemoryConfigStore,
} from "@triplex-build/triplex/config";
import * as Derivation from "@triplex-build/triplex/derivation";
import { EntityHttp, HttpAuthorizationAllowAll } from "@triplex-build/triplex-http";
import { PgTriples } from "@triplex-build/triplex-postgres";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";

export const MAR_2 = Date.UTC(2026, 2, 2);
export const maria = EntityId.make("worker:maria");
export const harbor = EntityId.make("site:harbor");

// #region model
// Attributes are global facts. Entity types say how each one is used.
export const Site = EntityType.make("Site", {
  attributes: { name: Attribute.use(Attribute.text(":site/name"), { required: true }) },
});

export const Worker = EntityType.make("Worker", {
  attributes: {
    name: Attribute.use(Attribute.text(":worker/name"), { required: true }),
    trainedFor: Attribute.use(Attribute.ref(":worker/trained-for", Site), { cardinality: "many" }),
  },
});

const placement = {
  worker: Attribute.use(Attribute.ref(":placement/worker", Worker), { required: true }),
  site: Attribute.use(Attribute.ref(":placement/site", Site), { required: true }),
};
export const Placement = EntityType.make("Placement", { attributes: placement });

// The next version of the rules: every placement needs a supervisor.
export const PlacementV2 = EntityType.make("Placement", {
  attributes: {
    ...placement,
    supervisor: Attribute.use(Attribute.text(":placement/supervisor"), { required: true }),
  },
});
// #endregion model

// #region release
// Publishing a model creates an immutable, content-addressed release and moves `live` to it.
export const publish = (label: string, types: ReadonlyArray<{ nodes: typeof Site.nodes }>) =>
  Effect.gen(function* () {
    const config = yield* ConfigStore.ConfigStore;
    const objects = yield* Effect.all(types.map((type) => type.nodes));
    return yield* config.commit({ label, objects: objects.flat(), ref: "live" });
  });
// #endregion release

// #region command
// One command is one atomic transaction: who acted, which command, under which rules.
export const placeWorker = (
  release: InMemoryConfigStore.ConfigSnapshot,
  placement: EntityId,
  worker: EntityId,
  site: EntityId,
) =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    const facts = Placement.assert(placement, { worker, site }, { validFrom: MAR_2 });
    return yield* triples.transact(facts, {
      actor: "user:dana",
      commandId: `create:${placement}`, // unique: a retry can never apply twice
      correlationId: "request:7f3a",
      ...(yield* GraphConstraint.pinned(release)), // the rules it answered to, enforced
    });
  });
// #endregion command

// #region ask
// Who placed Maria, under which rules, and was she trained, as known then and now?
export const audit = Effect.gen(function* () {
  const triples = yield* Triples;
  const config = yield* ConfigStore.ConfigStore;
  const receipt = yield* triples.transactionByCommand("create:placement:maria-harbor");
  if (receipt === null || !ContentId.isContentId(receipt.configSnapshot)) {
    return yield* Effect.die("placement was not pinned to a release");
  }

  const trained = (basis: TemporalBasis) =>
    triples
      .match({ entityId: maria, attribute: Worker.trainedFor.key }, basis)
      .pipe(Effect.map((facts) => facts.length > 0));

  return {
    actor: receipt.actor,
    governedBy: (yield* config.snapshotById(receipt.configSnapshot))?.label,
    liveToday: (yield* config.resolveRef("live"))?.label,
    trainedAsKnownThen: yield* trained({ validAt: MAR_2, recordedAt: receipt.instant }),
    trainedAsKnownNow: yield* trained({ validAt: MAR_2 }),
  };
});
// #endregion ask

// #region derive
// Open work is a query: a placed worker without current training for that site.
export const openWork = (configSnapshot: string, validAt: number) =>
  Effect.gen(function* () {
    const training = yield* Derivation.make({
      name: "task.site-safety-training",
      query: {
        find: ["?worker", "?site"],
        where: [
          ["?placement", Placement.worker.key, "?worker"],
          ["?placement", Placement.site.key, "?site"],
          ["not", ["?worker", Worker.trainedFor.key, "?site"]],
        ],
      },
      identity: ["?worker", "?site"],
      configSnapshot,
    });
    const { candidates, nextTemporalBoundary } = yield* Derivation.evaluate(
      yield* Triples,
      training,
      { basis: { validAt } },
    );
    return {
      open: candidates.map((task) => task.result),
      recheckAt: nextTemporalBoundary === undefined ? null : new Date(nextTemporalBoundary),
    };
  });
// #endregion derive

// #region run
// The same program runs on any storage. Only the layer changes.
export const InMemory = ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer));
export const Sqlite = ConfigStore.layer.pipe(
  Layer.provideMerge(SqliteTriples.layer({ filename: "app.db" })),
);
export const Postgres = ConfigStore.layer.pipe(
  Layer.provideMerge(PgTriples.layerFromUrl("postgres://localhost/app")),
);

// The `live` release is also a REST API with OpenAPI docs and as-of reads.
export const Api = EntityHttp.layer({
  docs: true,
  exposure: { collections: { Worker: "workers", Placement: "placements" } },
}).pipe(Layer.provide(HttpAuthorizationAllowAll)); // bring your own auth in production

export const Server = HttpRouter.serve(Api).pipe(
  Layer.provide(Sqlite),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
);
// #endregion run
