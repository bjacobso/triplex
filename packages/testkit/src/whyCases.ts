import { Effect, Layer } from "effect";
import { EntityId, Triples, string, type SealedValue } from "@triplex-build/triplex";
import { Attribute, EntityType, ConfigStore } from "@triplex-build/triplex/config";
import * as Derivation from "@triplex-build/triplex/derivation";
import { Why } from "@triplex-build/triplex/why";
import { attributeFixture, candidateFixture } from "./whyFixtures.js";

const check = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new Error(message));
const normalized = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(normalized)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, v]) => [key, normalized(v)]),
        )
      : value;
const equal = (a: unknown, b: unknown, message: string) =>
  check(
    JSON.stringify(normalized(a)) === JSON.stringify(normalized(b)),
    `${message}\nactual: ${JSON.stringify(a)}\nexpected: ${JSON.stringify(b)}`,
  );

/** Shared KV/SQLite/PostgreSQL cases. Run in a fresh store with a controllable commit clock. */
export const whyConformance = (setTime: (instant: number) => void) =>
  Effect.gen(function* () {
    const t = yield* Triples;
    const config = yield* ConfigStore.ConfigStore;
    const why = yield* Why;
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
    const maria = EntityId.make("worker:maria"),
      harbor = EntityId.make("site:harbor"),
      entityId = EntityId.make("placement:maria-harbor");
    const MAR_1 = Date.UTC(2026, 2, 1),
      MAR_2 = Date.UTC(2026, 2, 2),
      MAR_3 = Date.UTC(2026, 2, 3),
      MAR_5 = Date.UTC(2026, 2, 5),
      JUN_1 = Date.UTC(2026, 5, 1);
    setTime(1794426788600);
    const release = yield* config.commit({
      label: "hr-2026.1",
      objects: yield* EntityType.nodesOf(Site, Worker, Placement),
      ref: "live",
    });
    setTime(1794426788610);
    yield* t.transact(
      [
        ...Site.assert(harbor, { name: "Harbor" }, { validFrom: MAR_1 }),
        ...Worker.assert(maria, { name: "Maria" }, { validFrom: MAR_1 }),
      ],
      { actor: "user:hr", commandId: "onboard:maria" },
    );
    setTime(1794426788620);
    const trained = yield* t.transact(
      Worker.assert(maria, { trainedFor: [harbor] }, { validFrom: MAR_1, validTo: JUN_1 }),
      { actor: "user:trainer", commandId: "training:record:maria-harbor" },
    );
    setTime(1794426788633);
    const placed = yield* t.transact(
      Placement.assert(entityId, { worker: maria, site: harbor }, { validFrom: MAR_2 }),
      {
        actor: "user:dana",
        commandId: "create:placement:maria-harbor",
        correlationId: "request:7f3a",
        configSnapshot: release.snapshot.id,
      },
    );
    setTime(1794426788640);
    yield* config.commit({
      label: "hr-2026.2",
      objects: yield* EntityType.nodesOf(Site, Worker, PlacementV2),
      ref: "live",
    });
    setTime(1794426788650);
    const correction = yield* t.transact(
      [
        { op: "retract", id: trained.triples[0]!.id },
        ...Worker.assert(maria, { trainedFor: [harbor] }, { validFrom: MAR_5, validTo: JUN_1 }),
      ],
      {
        actor: "user:auditor",
        commandId: "training:correct:maria-harbor",
        causationId: "audit:2026-q1",
      },
    );
    const basis = { recordedPosition: 6, validAt: MAR_3 };
    const attribute = yield* why.why(
      { kind: "attribute", entityId, attribute: ":placement/site" },
      { basis },
    );
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
      configSnapshot: release.snapshot.id,
    });
    const candidate = (yield* Derivation.evaluate(t, training, { basis })).candidates[0]!;
    const candidateSubject = {
      kind: "candidate",
      definition: training,
      candidateId: candidate.id,
      revision: candidate.revision,
    } as const;
    const explained = yield* why.why(candidateSubject, { basis });
    // Only generated fact/transaction IDs and the source-ID-dependent revision differ.
    const substitutions = new Map<string, string>([
      [
        attributeFixture.facts[0].tripleId,
        placed.triples.find((f) => f.attribute === ":placement/site")!.id,
      ],
      [
        candidateFixture.facts[1].tripleId,
        placed.triples.find((f) => f.attribute === ":placement/worker")!.id,
      ],
      [attributeFixture.transactions[0].txId, placed.txId],
      [candidateFixture.subject.revision, candidate.revision],
    ]);
    const fixture = (value: unknown): unknown =>
      typeof value === "string"
        ? (substitutions.get(value) ?? value)
        : Array.isArray(value)
          ? value.map(fixture)
          : value !== null && typeof value === "object"
            ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fixture(v)]))
            : value;
    yield* equal(attribute, fixture(attributeFixture), "worked attribute DTO");
    yield* equal(explained, fixture(candidateFixture), "worked candidate DTO");
    yield* equal(JSON.parse(JSON.stringify(explained)), explained, "JSON round trip");
    yield* check(
      explained.facts.length === 2 && explained.transactions.every((tx) => tx.txId === placed.txId),
      "negation has no fabricated correction witness",
    );
    const oldSubject = { kind: "fact", tripleId: trained.triples[0]!.id } as const;
    const before = yield* why.why(oldSubject, { basis: { ...basis, recordedPosition: 3 } });
    yield* check(
      before.facts[0]!.visible &&
        before.facts[0]!.recorded.to === null &&
        before.transactions.length === 1,
      "before correction excludes later metadata",
    );
    const after = yield* why.why(oldSubject, { basis, causationDepth: 1 });
    yield* check(
      !after.facts[0]!.visible &&
        after.facts[0]!.retraction === correction.txId &&
        after.facts[0]!.valid.to === JUN_1,
      "retraction retains valid interval",
    );
    yield* check(
      after.causation.traces.some((trace) => trace.stop.reason === "missing"),
      "external command is a missing cause",
    );
    const early = yield* Effect.result(
      why.why(
        { kind: "fact", tripleId: placed.triples[0]!.id },
        { basis: { ...basis, recordedPosition: 3 } },
      ),
    );
    yield* check(
      early._tag === "Failure" && early.failure._tag === "WhySubjectNotFound",
      "assertion after cut is missing",
    );
    const future = yield* why.why({ kind: "fact", tripleId: correction.triples[0]!.id }, { basis });
    yield* check(!future.facts[0]!.visible, "future-valid fact by ID");
    for (const [validAt, count] of [
      [MAR_5, 1],
      [JUN_1, 0],
    ] as const) {
      const state = yield* why.why(
        { kind: "attribute", entityId: maria, attribute: Worker.trainedFor.key },
        { basis: { ...basis, validAt } },
      );
      yield* check(state.facts.length === count, "half-open interval endpoint");
    }
    for (const validAt of [Date.UTC(2026, 3, 1), JUN_1]) {
      const evaluated = yield* Derivation.evaluate(t, training, { basis: { ...basis, validAt } });
      yield* check(
        evaluated.candidates.length === (validAt === JUN_1 ? 1 : 0),
        "expired sources/negation replay",
      );
    }
    const mismatch = yield* Effect.result(
      why.why({ ...candidateSubject, revision: training.id }, { basis }),
    );
    yield* check(
      mismatch._tag === "Failure" && mismatch.failure._tag === "WhyCandidateRevisionMismatch",
      "revision mismatch",
    );
    const noBasis = yield* Effect.result(why.why(candidateSubject));
    yield* check(
      noBasis._tag === "Failure" && noBasis.failure._tag === "WhyInvalidRequest",
      "candidate requires exact basis",
    );
    yield* check(
      (yield* why.why({ kind: "entity", entityId: EntityId.make("absent") }, { basis })).facts
        .length === 0,
      "empty entity succeeds",
    );
    const multi = EntityId.make("multi");
    setTime(1794426788700);
    const first = yield* t.transact(
      [
        {
          op: "assert",
          entityId: multi,
          attribute: ":multi/value",
          value: string("a"),
          validFrom: 0,
        },
        {
          op: "assert",
          entityId: multi,
          attribute: ":multi/value",
          value: string("b"),
          validFrom: 0,
        },
      ],
      { commandId: "root", configSnapshot: "legacy-release" },
    );
    const second = yield* t.transact(
      [
        {
          op: "assert",
          entityId: multi,
          attribute: ":multi/other",
          value: string("c"),
          validFrom: 0,
        },
      ],
      { commandId: "child", causationId: "root" },
    );
    const third = yield* t.transact(
      [
        {
          op: "assert",
          entityId: multi,
          attribute: ":multi/third",
          value: string("d"),
          validFrom: 0,
        },
      ],
      { commandId: "grandchild", causationId: "child" },
    );
    const tied = yield* why.why(
      { kind: "entity", entityId: multi },
      { basis: { recordedAt: 1794426788700, validAt: 1 }, causationDepth: 1 },
    );
    yield* check(
      tied.basis.recordedPosition === third.position && tied.facts.length === 4,
      "equal timestamps and complete multi-valued entity",
    );
    yield* check(
      tied.transactions.length === 3 && tied.transactions[0]!.release.status === "missing",
      "ancestor table deduplicates and invalid pin is missing",
    );
    yield* check(
      tied.causation.traces.find((trace) => trace.start === third.txId)!.stop.reason ===
        "depth-limit",
      "exact depth limit",
    );
    const chain = yield* why.why(
      { kind: "fact", tripleId: third.triples[0]!.id },
      { basis: { validAt: 1 }, causationDepth: 2 },
    );
    yield* equal(
      chain.causation.traces[0]!.ancestors,
      [second.txId, first.txId],
      "immediate parent first",
    );
    yield* check(chain.causation.traces[0]!.stop.reason === "root", "chain terminates at root");
    const makeLink = (commandId: string, causationId: string) =>
      t.transact(
        [
          {
            op: "assert",
            entityId: EntityId.make(commandId),
            attribute: ":link/value",
            value: string("v"),
            validFrom: 0,
          },
        ],
        { commandId, causationId },
      );
    const self = yield* makeLink("self", "self");
    const a = yield* makeLink("cycle-a", "cycle-b");
    const b = yield* makeLink("cycle-b", "cycle-a");
    for (const tx of [self, a, b]) {
      const cycle = yield* why.why(
        { kind: "fact", tripleId: tx.triples[0]!.id },
        { basis: { validAt: 1 }, causationDepth: 32 },
      );
      yield* check(cycle.causation.traces[0]!.stop.reason === "cycle", "self/multi-command cycle");
    }
    const afterBasis = yield* why.why(
      { kind: "fact", tripleId: a.triples[0]!.id },
      { basis: { validAt: 1, recordedPosition: a.position }, causationDepth: 2 },
    );
    yield* check(
      afterBasis.causation.traces[0]!.stop.reason === "after-basis" &&
        afterBasis.transactions.length === 1,
      "after-basis parent withheld",
    );
    for (const options of [
      { causationDepth: -1 },
      { causationDepth: 33 },
      { causationDepth: 0.5 },
      { basis: { validAt: NaN } },
      { basis: { recordedAt: 1, recordedPosition: 1 } },
    ]) {
      const result = yield* Effect.result(why.why({ kind: "entity", entityId: multi }, options));
      yield* check(
        result._tag === "Failure" && result.failure._tag === "WhyInvalidRequest",
        "invalid request",
      );
    }
    // Stored envelopes and their journal copies remain opaque without any codec service.
    const sealed: SealedValue = {
      type: "sealed",
      keyId: "key",
      ciphertext: "opaque",
      blind: "opaque-token",
      valueType: "string",
    };
    const secret = yield* t.transact([
      {
        op: "assert",
        entityId: EntityId.make("secret"),
        attribute: ":secret/value",
        value: sealed,
        validFrom: 0,
      },
    ]);
    const secretExplanation = yield* why.why(
      { kind: "fact", tripleId: secret.triples[0]!.id },
      { basis: { validAt: 1 } },
    );
    yield* equal(secretExplanation.facts[0]!.value, sealed, "sealed value stays opaque");
    yield* check(
      !("changes" in secretExplanation.transactions[0]!),
      "unrelated journal changes omitted",
    );
    const secretDefinition = yield* Derivation.make({
      name: "secret",
      query: {
        find: ["?entity"],
        where: [["?entity", ":secret/value", { type: "blind", value: "opaque-token" }]],
      },
      identity: ["?entity"],
      configSnapshot: "legacy",
    });
    const secretBasis = { validAt: 1, recordedPosition: secret.position };
    const secretCandidate = (yield* Derivation.evaluate(t, secretDefinition, {
      basis: secretBasis,
    })).candidates[0]!;
    const secretCandidateExplanation = yield* why.why(
      {
        kind: "candidate",
        definition: secretDefinition,
        candidateId: secretCandidate.id,
        revision: secretCandidate.revision,
      },
      { basis: secretBasis },
    );
    yield* equal(
      secretCandidateExplanation.facts[0]!.value,
      sealed,
      "sealed candidate source stays opaque",
    );
  });

/** Compose Why and ConfigStore over an existing Triples runtime for conformance callers. */
export const whyTestLayer = Why.layer.pipe(Layer.provideMerge(ConfigStore.layer));
