import { Effect } from "effect";
import { EntityId, Triples, string } from "@triplex-internal/core";

/** Run with a fresh store whose injected runtime clock is controlled by setTime. */
export const recordedReadsConformance = (setTime: (instant: number) => void) =>
  Effect.gen(function* () {
    const t = yield* Triples;
    const check = (condition: boolean, message: string) =>
      condition ? Effect.void : Effect.fail(new Error(message));
    const commit = (attribute: string, validFrom: number, validTo?: number) =>
      t.transact([
        {
          op: "assert",
          entityId: EntityId.make("recorded:subject"),
          attribute,
          value: string("value"),
          validFrom,
          validTo,
        },
      ]);
    yield* check((yield* t.resolveRecordedBasis()).recordedPosition === 0, "empty head");
    yield* check(
      JSON.stringify(yield* t.dependencyStateAll()) === '{"sourcePosition":0}',
      "empty wildcard state",
    );
    setTime(100);
    const first = yield* commit(":recorded/first", 10, 400);
    setTime(200);
    yield* commit(":recorded/second", 500, 800);
    const tied = yield* commit(":recorded/third", 600);
    for (const [basis, expected] of [
      [undefined, tied.position],
      [{ recordedAt: 150 }, first.position],
      [{ recordedAt: 150.5 }, first.position],
      [{ recordedAt: 200 }, tied.position],
      [{ recordedAt: 99 }, 0],
      [{ recordedAt: 1000 }, tied.position],
      [{ recordedPosition: first.position }, first.position],
    ] as const) {
      yield* check(
        (yield* t.resolveRecordedBasis(basis)).recordedPosition === expected,
        `recorded basis ${JSON.stringify(basis)}`,
      );
    }
    for (const basis of [
      { recordedPosition: tied.position + 1 },
      { recordedAt: 200, recordedPosition: 1 },
      { recordedPosition: -1 },
      { recordedPosition: 0.5 },
      { recordedAt: Number.NaN },
    ]) {
      const result = yield* Effect.result(t.resolveRecordedBasis(basis));
      yield* check(
        result._tag === "Failure" && result.failure._tag === "ReadError",
        "invalid basis is ReadError",
      );
    }
    setTime(300);
    const retraction = yield* t.transact([{ op: "retract", id: first.triples[0]!.id }]);
    // Include journal attributes: wildcard dependencies cover all stored attributes.
    const attrs = [
      ...new Set((yield* t.history(EntityId.make("recorded:subject"))).map((f) => f.attribute)),
    ];
    for (const tx of [first, tied, retraction]) {
      attrs.push(...(yield* t.history(EntityId.make(tx.txId))).map((f) => f.attribute));
    }
    for (const recordedPosition of [first.position, tied.position, retraction.position]) {
      const basis = { recordedPosition, validAt: 100 };
      const states = yield* Effect.forEach([...new Set(attrs)], (a) =>
        t.dependencyState([a], basis),
      );
      const boundaries = states.flatMap((s) =>
        s.nextTemporalBoundary === undefined ? [] : [s.nextTemporalBoundary],
      );
      const all = yield* t.dependencyStateAll(basis);
      yield* check(
        all.sourcePosition === Math.max(...states.map((s) => s.sourcePosition)) &&
          all.nextTemporalBoundary === Math.min(...boundaries),
        "wildcard equals fixed union at cut",
      );
    }
    yield* check(
      (yield* t.dependencyStateAll({ recordedPosition: tied.position, validAt: 350 }))
        .nextTemporalBoundary === 400,
      "historical retraction retains old future edge",
    );
    yield* check(
      (yield* t.dependencyStateAll({ validAt: 350 })).nextTemporalBoundary === 500,
      "retraction removes edge and future assertion schedules start",
    );
    yield* check(
      JSON.stringify(yield* t.dependencyState([], { validAt: 100 })) === '{"sourcePosition":0}',
      "empty dependencies stay empty",
    );
    yield* check(
      JSON.stringify(yield* t.dependencyStateAll({ recordedAt: 100, validAt: 350 })) ===
        JSON.stringify(
          yield* t.dependencyStateAll({ recordedPosition: first.position, validAt: 350 }),
        ),
      "wildcard timestamp cut agrees with exact position cut",
    );
    // Clock rollback must still select greatest committed position, not latest instant.
    setTime(150);
    const rollback = yield* commit(":recorded/rollback", 1000);
    setTime(400); // Exercise the historical index, rather than the future-to-head shortcut.
    yield* check(
      (yield* t.resolveRecordedBasis({ recordedAt: 200 })).recordedPosition === rollback.position,
      "timestamp lookup remains position ordered after clock rollback",
    );
  });
