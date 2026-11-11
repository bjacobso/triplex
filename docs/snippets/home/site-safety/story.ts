/**
 * The rest of the homepage story: onboarding, training evidence, a retried
 * command, and the auditor's correction. `run.ts` plays these in order.
 */
import { Effect } from "effect";
import { EntityId, Triples } from "@triplex-build/triplex";
import type { InMemoryConfigStore } from "@triplex-build/triplex/config";
import { Site, Worker, harbor, maria, placeWorker } from "./app.ts";

export const JAN_5 = Date.UTC(2026, 0, 5);
export const MAR_1 = Date.UTC(2026, 2, 1);
export const MAR_5 = Date.UTC(2026, 2, 5);
export const JUN_1 = Date.UTC(2026, 5, 1);
export const pier = EntityId.make("site:pier");

export const onboard = Effect.gen(function* () {
  const triples = yield* Triples;
  const since = { validFrom: JAN_5 };
  return yield* triples.transact(
    [
      ...Site.assert(harbor, { name: "Harbor" }, since),
      ...Site.assert(pier, { name: "Pier" }, since),
      ...Worker.assert(maria, { name: "Maria" }, since),
    ],
    { actor: "user:hr", commandId: "onboard:maria" },
  );
});

// Evidence holds for a window of business time: [validFrom, validTo).
export const recordTraining = Effect.gen(function* () {
  const triples = yield* Triples;
  return yield* triples.transact(
    Worker.assert(maria, { trainedFor: [harbor] }, { validFrom: MAR_1, validTo: JUN_1 }),
    { actor: "user:trainer", commandId: "training:record:maria-harbor" },
  );
});

// #region retry
// A retried command must never apply twice. The duplicate is rejected with the
// original transaction, so the caller can answer with the first receipt.
export const placeWorkerOnce = (release: InMemoryConfigStore.ConfigSnapshot) =>
  placeWorker(release, EntityId.make("placement:maria-harbor"), maria, harbor).pipe(
    Effect.map((result) => result.position),
    Effect.catchTag("CommandAlreadyCommittedError", (duplicate) =>
      Effect.gen(function* () {
        const triples = yield* Triples;
        const receipt = yield* triples.transactionByCommand(duplicate.commandId);
        return receipt?.position;
      }),
    ),
  );
// #endregion retry

// #region correct
// A correction never deletes history. It retracts the recorded belief and
// asserts what is now known, in one attributed transaction.
export const correctTraining = Effect.gen(function* () {
  const triples = yield* Triples;
  const [wrong] = yield* triples.match(
    { entityId: maria, attribute: Worker.trainedFor.key },
    { validAt: MAR_1 },
  );
  if (wrong === undefined) return yield* Effect.die("no training evidence to correct");
  return yield* triples.transact(
    [
      { op: "retract", id: wrong.id },
      ...Worker.assert(maria, { trainedFor: [harbor] }, { validFrom: MAR_5, validTo: JUN_1 }),
    ],
    {
      actor: "user:auditor",
      commandId: "training:correct:maria-harbor",
      causationId: "audit:2026-q1",
    },
  );
});
// #endregion correct
