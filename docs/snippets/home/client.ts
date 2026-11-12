// #region model
import { Effect, Layer } from "effect";
import { EntityId, KvTriples } from "@triplex-build/triplex";
import { Attribute, ConfigStore, EntityType } from "@triplex-build/triplex/config";
import * as Database from "@triplex-build/triplex/database";
import { Why } from "@triplex-build/triplex/why";

const Worker = EntityType.make("Worker", {
  name: Attribute.text(":worker/name").required(),
});
const Model = { types: [Worker] } as const;
const maria = EntityId.make("worker:maria");
const MAR_2 = Date.UTC(2026, 2, 2);
// #endregion model

// #region release
const publish = Effect.gen(function* () {
  const config = yield* ConfigStore.ConfigStore;
  return yield* config.commit({
    label: "workers-v1",
    objects: yield* EntityType.nodesOf(...Model.types),
    ref: "live",
  });
});
const Client = Database.layer({ schema: Model });
// #endregion release

const program = Effect.gen(function* () {
  // #region command
  const db = yield* Database.Database;
  const createWorker = () =>
    db.command({ actor: "user:dana", commandId: "create:worker:maria" }, (tx) =>
      tx.create(Worker, maria, { name: "Maria" }, { validFrom: MAR_2 }),
    );
  const receipt = yield* createWorker();
  const retry = yield* createWorker(); // same receipt, no second write
  // #endregion command

  // #region read
  const worker = yield* db.get(Worker, maria); // { entityId, values } | null
  const page = yield* db.list(Worker, { limit: 25 });
  // worker?.values.name is typed from Worker; page.nextCursor continues the list.
  // #endregion read

  // #region audit
  // Correct the original belief without losing its history.
  const nameFact = receipt.changes.find(
    (change) => change.op === "assert" && change.attribute === Worker.attributes.name.key,
  );
  if (nameFact === undefined) return yield* Effect.die("Missing name assertion");
  yield* db.command({ actor: "user:auditor", commandId: "correct:worker:maria:name" }, (tx) =>
    Effect.gen(function* () {
      const fact = yield* tx.fact(Worker, nameFact.tripleId);
      yield* tx.correct(Worker, fact, { name: "Maria Rivera" });
    }),
  );
  const basis = { recordedPosition: receipt.position, validAt: MAR_2 };
  const then = yield* db.asOf(basis);
  const knownThen = yield* then.get(Worker, maria); // name: "Maria"
  const current = yield* db.get(Worker, maria); // name: "Maria Rivera"
  // #endregion audit

  // #region why
  const why = yield* Why;
  const explanation = yield* why.why(
    { kind: "entity", entityId: maria },
    { basis }, // explain the same recorded cut and business time
  );
  // explanation.transactions includes Dana's command and its workers-v1 release.
  // #endregion why
  return { receipt, retry, worker, page, knownThen, current, explanation };
});

// #region run
const Store = ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer));
const Services = Layer.merge(Client, Why.layer);
// Publish before acquiring the client. Both effects share one Store instance.
export const main = publish.pipe(
  Effect.andThen(program.pipe(Effect.provide(Services))),
  Effect.provide(Store),
);
// await Effect.runPromise(main) at your application boundary.
// For SQLite, import SqliteTriples from "@triplex-build/triplex/sqlite" and use
// SqliteTriples.layer({ filename: "./app.db" }) in place of KvTriples.layer.
// #endregion run
