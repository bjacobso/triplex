import { Deferred, Effect, Fiber, Layer, Option, Cause, Exit } from "effect";
import {
  EntityId,
  TripleId,
  Triples,
  ReadError,
  string,
  type TriplesService,
} from "@triplex-internal/core";
import * as Derivation from "@triplex-internal/core/derivation";
import { ConfigStore } from "@triplex-internal/core/config";
import { Why, type WhySubject, type WhyOptions } from "@triplex-internal/core/why";

/** Fault injection uses public service decorators, shared across backend runtimes. */
export const whyReadBoundaryConformance = Effect.gen(function* () {
  const t = yield* Triples;
  const config = yield* ConfigStore.ConfigStore;
  const check = (ok: boolean, message: string) =>
    ok ? Effect.void : Effect.fail(new Error(message));
  const written = yield* t.transact(
    [
      {
        op: "assert",
        entityId: EntityId.make("why:boundary"),
        attribute: ":boundary/value",
        value: string("value"),
        validFrom: 100,
      },
    ],
    { actor: "author", commandId: "boundary", causationId: "external" },
  );
  const fact = written.triples[0]!;
  const subject = { kind: "fact", tripleId: fact.id } as const;
  const basis = { recordedPosition: written.position, validAt: 150 };
  const run = (store: TriplesService, subject: WhySubject, options: WhyOptions = { basis }) =>
    Effect.flatMap(Why, (why) => why.why(subject, options)).pipe(
      Effect.provide(
        Layer.fresh(Why.layer).pipe(
          Layer.provide(Layer.succeed(Triples, store)),
          Layer.provide(Layer.succeed(ConfigStore.ConfigStore, config)),
        ),
      ),
    );
  let parentReads = 0;
  const counted = {
    ...t,
    transactionByCommand: (id: string) => {
      parentReads++;
      return t.transactionByCommand(id);
    },
  };
  yield* run(counted, subject);
  yield* check(parentReads === 0, "depth zero performs no parent read");
  yield* run(counted, subject, { basis, causationDepth: 1 });
  yield* check(parentReads === 1, `requested depth reads parent (${parentReads})`);
  const extraSubject = { ...subject, extra: "do-not-echo" };
  const clean = yield* run(t, extraSubject);
  yield* check(
    !JSON.stringify(clean).includes("do-not-echo"),
    "subject DTO does not echo extra input fields",
  );
  const badValue = yield* Effect.result(
    run(
      {
        ...t,
        transaction: (id) =>
          t
            .transaction(id)
            .pipe(
              Effect.map((tx) =>
                tx
                  ? { ...tx, changes: tx.changes.map((c) => ({ ...c, value: string("corrupt") })) }
                  : null,
              ),
            ),
      },
      subject,
    ),
  );
  yield* check(
    badValue._tag === "Failure" && badValue.failure._tag === "WhyIncompleteHistory",
    "receipt value inconsistency is corrupt history",
  );
  const wrongId = yield* Effect.result(
    run(
      { ...t, assertion: () => Effect.succeed(fact) },
      { ...subject, tripleId: TripleId.make("00000000000000000000000000") },
    ),
  );
  yield* check(
    wrongId._tag === "Failure" && wrongId.failure._tag === "WhyIncompleteHistory",
    "identity read cannot substitute another assertion",
  );
  const storageFailure = new ReadError({ message: "injected storage failure" });
  const failed = yield* Effect.result(
    run({ ...t, assertion: () => Effect.fail(storageFailure) }, subject),
  );
  yield* check(
    failed._tag === "Failure" && failed.failure === storageFailure,
    "storage failures propagate unchanged",
  );
  const corrupt = yield* Effect.result(
    run(
      {
        ...t,
        transaction: (id) =>
          t
            .transaction(id)
            .pipe(
              Effect.map((tx) =>
                tx ? { ...tx, position: tx.position + 1, instant: tx.instant + 1 } : null,
              ),
            ),
      },
      subject,
    ),
  );
  yield* check(
    corrupt._tag === "Failure" && corrupt.failure._tag === "WhyIncompleteHistory",
    "corrupt receipt distinct from absence",
  );
  const legacy = { ...fact, txId: Option.none(), createdBy: Option.some("never-infer-this-actor") };
  const legacyStore = {
    ...t,
    assertion: () => Effect.succeed(legacy),
    transaction: () => Effect.succeed(null),
    transactionsForEntity: () =>
      Effect.succeed({ transactions: [], snapshotPosition: written.position }),
  };
  const gaps = yield* run(legacyStore, subject);
  yield* check(
    gaps.facts[0]!.assertion === null &&
      gaps.gaps[0]!.kind === "missing-assertion" &&
      gaps.transactions.length === 0,
    "unattributed legacy assertion remains with a gap",
  );
  const ambiguous = yield* Effect.result(
    run({ ...legacyStore, entity: () => Effect.succeed([]) }, subject),
  );
  yield* check(
    ambiguous._tag === "Failure" && ambiguous.failure._tag === "WhyIncompleteHistory",
    "missing legacy position never guessed from timestamp",
  );
  let captured = false;
  const concurrent = {
    ...t,
    resolveRecordedBasis: () =>
      Effect.gen(function* () {
        const cut = yield* t.resolveRecordedBasis();
        if (!captured) {
          captured = true;
          yield* t.transact([{ op: "retract", id: fact.id }]).pipe(Effect.orDie);
        }
        return cut;
      }),
  };
  const historical = yield* run(concurrent, subject, { basis: { validAt: 150 } });
  yield* check(
    historical.basis.recordedPosition === written.position &&
      historical.facts[0]!.visible &&
      historical.facts[0]!.retraction === null &&
      historical.transactions.length === 1,
    "concurrent retraction after capture stays outside result",
  );
  const legacyRetraction = {
    ...t,
    transaction: (id: Parameters<TriplesService["transaction"]>[0]) =>
      id === written.txId ? t.transaction(id) : Effect.succeed(null),
    transactionsForEntity: () =>
      Effect.succeed({ transactions: [], snapshotPosition: written.position + 1 }),
  };
  const retractionGap = yield* run(legacyRetraction, subject, { basis: { validAt: 150 } });
  yield* check(
    retractionGap.facts[0]!.retraction === null &&
      retractionGap.facts[0]!.recorded.to !== null &&
      retractionGap.gaps[0]!.kind === "missing-retraction",
    "known retired assertion with missing retractor stays a gap",
  );
  const after = yield* Effect.result(
    run(t, subject, { basis: { recordedPosition: 999999, validAt: 150 } }),
  );
  yield* check(
    after._tag === "Failure" && after.failure._tag === "WhyInvalidRequest",
    "ahead basis is invalid request",
  );
  const entered = yield* Deferred.make<void>();
  const blocked = {
    ...t,
    transactionByCommand: () =>
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
  };
  const fiber = yield* run(blocked, subject, { basis, causationDepth: 1 }).pipe(Effect.forkChild);
  yield* Deferred.await(entered);
  yield* Fiber.interrupt(fiber);
  const exit = yield* Fiber.await(fiber);
  yield* check(
    Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause),
    "cancellation remains interruption",
  );
  const parent = yield* t.transact([], { commandId: "boundary-parent" });
  const sharedEntity = EntityId.make("why:shared-ancestor");
  for (const child of ["one", "two"])
    yield* t.transact(
      [
        {
          op: "assert",
          entityId: sharedEntity,
          attribute: ":boundary/child",
          value: string(child),
          validFrom: 100,
        },
      ],
      { commandId: `boundary-${child}`, causationId: "boundary-parent" },
    );
  let sharedReads = 0;
  const shared = yield* run(
    {
      ...t,
      transactionByCommand: (id) => {
        sharedReads++;
        return t.transactionByCommand(id);
      },
    },
    { kind: "entity", entityId: sharedEntity },
    { basis: { validAt: 150 }, causationDepth: 1 },
  );
  yield* check(
    sharedReads === 1 && shared.transactions.filter((tx) => tx.txId === parent.txId).length === 1,
    "shared ancestor lookup and envelope are deduplicated",
  );
  const source = yield* t.transact([
    {
      op: "assert",
      entityId: EntityId.make("why:concurrent-source"),
      attribute: ":boundary/source",
      value: string("positive"),
      validFrom: 100,
    },
  ]);
  const candidateBasis = { validAt: 150, recordedPosition: source.position };
  const definition = yield* Derivation.make({
    name: "concurrent-source",
    query: { find: ["?entity"], where: [["?entity", ":boundary/source", "positive"]] },
    identity: ["?entity"],
    configSnapshot: "legacy",
  });
  const candidate = (yield* Derivation.evaluate(t, definition, { basis: candidateBasis }))
    .candidates[0]!;
  let retracted = false;
  const racing = {
    ...t,
    assertion: (id: Parameters<TriplesService["assertion"]>[0]) =>
      Effect.gen(function* () {
        if (!retracted) {
          retracted = true;
          yield* t.transact([{ op: "retract", id }]).pipe(Effect.orDie);
        }
        return yield* t.assertion(id);
      }),
  };
  const replay = yield* run(
    racing,
    { kind: "candidate", definition, candidateId: candidate.id, revision: candidate.revision },
    { basis: candidateBasis },
  );
  yield* check(
    replay.facts[0]!.visible && replay.facts[0]!.retraction === null,
    "candidate source retracted after evaluation remains explainable at its cut",
  );
});
