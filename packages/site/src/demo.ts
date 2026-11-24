/**
 * Every hosted MCP session starts with the homepage's site-safety story
 * (docs/snippets/home/site-safety), played as real attributed commands, and a
 * tour that points an agent at what Triplex does that other stores do not.
 */
import { EntityId, Triples } from "@triplex-build/triplex";
import { Attribute, ConfigStore, EntityType, GraphConstraint } from "@triplex-build/triplex/config";
import { Effect } from "effect";

const JAN_5 = Date.UTC(2026, 0, 5);
const MAR_1 = Date.UTC(2026, 2, 1);
const MAR_2 = Date.UTC(2026, 2, 2);
const MAR_5 = Date.UTC(2026, 2, 5);
const JUN_1 = Date.UTC(2026, 5, 1);

const maria = EntityId.make("worker:maria");
const harbor = EntityId.make("site:harbor");
const pier = EntityId.make("site:pier");

const Site = EntityType.make("Site", { name: Attribute.text(":site/name").required() });
const Worker = EntityType.make("Worker", {
  name: Attribute.text(":worker/name").required(),
  trainedFor: Attribute.ref(":worker/trained-for", Site).many(),
});
const placement = {
  worker: Attribute.ref(":placement/worker", Worker).required(),
  site: Attribute.ref(":placement/site", Site).required(),
};
const Placement = EntityType.make("Placement", placement);
const PlacementV2 = EntityType.make("Placement", {
  ...placement,
  supervisor: Attribute.text(":placement/supervisor").required(),
});

// Recorded time comes from the clock, which a Worker only advances across I/O.
const tick = Effect.sleep("5 millis");

export const seed = Effect.gen(function* () {
  const triples = yield* Triples;
  const config = yield* ConfigStore.ConfigStore;
  const publish = (label: string, types: ReadonlyArray<{ nodes: typeof Site.nodes }>) =>
    Effect.gen(function* () {
      return yield* config.commit({
        label,
        objects: yield* EntityType.nodesOf(...types),
        ref: "live",
      });
    });

  const first = yield* publish("hr-2026.1", [Site, Worker, Placement]);
  yield* tick;
  yield* triples.transact(
    [
      ...Site.assert(harbor, { name: "Harbor" }, { validFrom: JAN_5 }),
      ...Site.assert(pier, { name: "Pier" }, { validFrom: JAN_5 }),
      ...Worker.assert(maria, { name: "Maria" }, { validFrom: JAN_5 }),
    ],
    { actor: "user:hr", commandId: "onboard:maria" },
  );
  yield* tick;
  yield* triples.transact(
    Worker.assert(maria, { trainedFor: [harbor] }, { validFrom: MAR_1, validTo: JUN_1 }),
    { actor: "user:trainer", commandId: "training:record:maria-harbor" },
  );
  yield* tick;
  yield* triples.transact(
    Placement.assert(
      EntityId.make("placement:maria-harbor"),
      { worker: maria, site: harbor },
      { validFrom: MAR_2 },
    ),
    {
      actor: "user:dana",
      commandId: "create:placement:maria-harbor",
      correlationId: "request:7f3a",
      ...(yield* GraphConstraint.pinned(first.snapshot)),
    },
  );
  yield* tick;
  yield* publish("hr-2026.2", [Site, Worker, PlacementV2]);
  yield* tick;
  const [wrong] = yield* triples.match(
    { entityId: maria, attribute: Worker.trainedFor.key },
    { validAt: MAR_1 },
  );
  yield* triples.transact(
    [
      { op: "retract", id: wrong!.id },
      ...Worker.assert(maria, { trainedFor: [harbor] }, { validFrom: MAR_5, validTo: JUN_1 }),
    ],
    {
      actor: "user:auditor",
      commandId: "training:correct:maria-harbor",
      causationId: "audit:2026-q1",
    },
  );
});

export const instructions = `This is a live Triplex database of your own, private to this MCP session. Triplex is a bitemporal fact database: every fact has a valid time (when it is true in the business) and a recorded time (when the database learned it), every write is an attributed, idempotent command pinned to a versioned schema release, and history is never overwritten.

Call the tour tool first. It tells the story already loaded (a worker placed at a construction site, and an audit that later corrected her training record) and lists questions to answer with the other tools. Then call describe for the live schema, rules and transaction examples. Writes are welcome; reset restores the story. Sessions are deleted after a day idle.`;

const day = (instant: number) => `${new Date(instant).toISOString().slice(0, 10)} (${instant})`;

export const tour = `# Triplex tour

Your database already holds the homepage story from https://triplex.build, played as six commands. Instants are epoch milliseconds (UTC).

1. Position 1: release hr-2026.1 publishes Site, Worker and Placement and moves the live ref to it.
2. user:hr onboards Maria and two sites, Harbor and Pier, valid from ${day(JAN_5)}.
3. user:trainer records that Maria is trained for Harbor from ${day(MAR_1)} until ${day(JUN_1)}.
4. user:dana places Maria at Harbor from ${day(MAR_2)}, command create:placement:maria-harbor, pinned to hr-2026.1.
5. Release hr-2026.2 makes :placement/supervisor required.
6. user:auditor finds the training actually started ${day(MAR_5)}: one command (causation audit:2026-q1) retracts the old fact and asserts the corrected one. Nothing is deleted.

## Things to try

- **See the whole history.** journal_list shows every transaction with its actor, command ID and the release it answered to.
- **Ask what was known, and when.** Was Maria trained for Harbor on ${day(MAR_2)}, the day she was placed? Call entity_get for worker:maria with basis { validAt: ${MAR_2} }: as known now, no. Then add recordedPosition (the placement's position, from journal_receipt for create:placement:maria-harbor): as known when Dana placed her, yes. Both answers stay true forever.
- **Ask why.** why with subject { kind: "attribute", entityId: "worker:maria", attribute: ":worker/trained-for" } and basis { validAt: ${Date.UTC(2026, 3, 1)} } explains the value on that day: the fact, its valid and recorded intervals, and the command, actor and causation that wrote it. (Without a basis it reads today, after the training expired.) entity_history and entity_facts show the retracted fact still in the record.
- **Query across time with Datalog.** query_run with find ["?worker", "?site"], where [["?p", ":placement/worker", "?worker"], ["?p", ":placement/site", "?site"], ["not", ["?worker", ":worker/trained-for", "?site"]]] lists placed workers who are not trained for their site. Run it at basis { validAt: ${Date.UTC(2026, 2, 3)} } (open work: Maria at Harbor), { validAt: ${Date.UTC(2026, 3, 1)} } (none) and { validAt: ${JUN_1} } (open again: training expired). query_explain shows the plan.
- **Let the rules say no before you write.** transaction_preview a placement of Maria at Pier pinned to the live release without a supervisor: it reports the constraint violation and commits nothing. Add :placement/supervisor and preview again, then transaction_apply it. describe gives the exact request shape and the configSnapshot to pin.
- **Retry safely.** transaction_apply the same command ID twice: the second is refused with the original transaction, and journal_receipt finds the receipt before a retry.
- **Compare releases.** config_release with ref "live", then with the snapshot ID the placement was pinned to, to see the rule that changed.
- **Change the story.** Correct a fact from a date on, end one with validTo, and read the entity at different validAt and recordedPosition bases. reset starts over.

Every result is structured JSON; failures carry a diagnostic code, a message and usually a fix.`;
