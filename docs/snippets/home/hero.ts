// The homepage hero replays this program's output (hero-run.ts).
// #region model
import { Effect, Layer } from "effect";
import {
  EntityId,
  KvTriples,
  type TransactionRecord,
} from "@triplex-build/triplex";
import {
  Attribute,
  ConfigStore,
  EntityType,
} from "@triplex-build/triplex/config";
import * as Database from "@triplex-build/triplex/database";
import { Why } from "@triplex-build/triplex/why";

const Worker = EntityType.make("Worker", {
  name: Attribute.text(":worker/name").required(),
  site: Attribute.text(":worker/site"),
});
// #endregion model

const maria = EntityId.make("worker:maria");
export const MAR_2 = Date.UTC(2026, 2, 2);
export const JUN_1 = Date.UTC(2026, 5, 1);

const publish = Effect.gen(function* () {
  const config = yield* ConfigStore.ConfigStore;
  return yield* config.commit({
    label: "workers-v1",
    objects: yield* EntityType.nodesOf(Worker),
    ref: "live",
  });
});

const factFor = (tx: TransactionRecord, attribute: string) => {
  const change = tx.changes.find(
    (c) => c.op === "assert" && c.attribute === attribute,
  );
  return change === undefined
    ? Effect.die(`Missing ${attribute}`)
    : Effect.succeed(change.tripleId);
};

const program = Effect.gen(function* () {
  const db = yield* Database.Database;
  const explain = yield* Why;

  // #region create
  const hire = { actor: "user:dana", commandId: "hire:maria" };
  const hired = yield* db.command(hire, (tx) =>
    tx.create(
      Worker,
      maria,
      { name: "Maria", site: "harbor" },
      { validFrom: MAR_2 },
    ),
  );
  // #endregion create

  const siteFact = yield* factFor(hired, ":worker/site");
  // #region move
  const move = { actor: "user:dana", commandId: "move:maria" };
  const moved = yield* db.command(move, (tx) =>
    Effect.gen(function* () {
      const site = yield* tx.fact(Worker, siteFact);
      // Pier from June 1. Harbor's months are kept.
      yield* tx.replace(Worker, site, { site: "pier" }, JUN_1);
    }),
  );
  // #endregion move

  const nameFact = yield* factFor(hired, ":worker/name");
  // #region correct
  const fix = { actor: "user:sam", commandId: "fix:maria" };
  const corrected = yield* db.command(fix, (tx) =>
    Effect.gen(function* () {
      const name = yield* tx.fact(Worker, nameFact);
      // The name was always Maria Rivera.
      yield* tx.correct(Worker, name, { name: "Maria Rivera" });
    }),
  );
  // #endregion correct

  // #region asof
  // March 2 as Dana knew it; June 1 as we know it now.
  const { position } = hired;
  const then = { recordedPosition: position, validAt: MAR_2 };
  const view = yield* db.asOf(then);
  const knownThen = yield* view.get(Worker, maria);
  const june = { validAt: JUN_1 };
  const now = yield* (yield* db.asOf(june)).get(Worker, maria);
  const entity = { kind: "entity", entityId: maria } as const;
  const why = yield* explain.why(entity, { basis: june });
  // #endregion asof

  return { hired, moved, corrected, knownThen, now, why };
});

const Store = ConfigStore.layer.pipe(
  Layer.provideMerge(KvTriples.layer),
);
const Client = Database.layer({ schema: { types: [Worker] } });
export const main = Effect.gen(function* () {
  const release = yield* publish;
  const result = yield* program.pipe(
    Effect.provide(Layer.merge(Client, Why.layer)),
  );
  return { release, ...result };
}).pipe(Effect.provide(Store));
