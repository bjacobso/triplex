// #region model
import { DateTime, Effect, Semaphore } from "effect";
import type { Pattern } from "../01/facts.ts";
import {
  StoreError,
  matches,
  replay,
  stage,
  type Assertion,
  type Change,
  type Transaction,
} from "../02/log.ts";

export type TimedFact = Assertion & {
  readonly validFrom: number;
  readonly validTo?: number;
};

export type TimedTransaction = Transaction<TimedFact> & {
  readonly recordedAt: number;
};

export type Basis = {
  readonly validAt: number;
  readonly recordedAt: number;
};

export const wallClock = DateTime.now.pipe(
  Effect.map(DateTime.toEpochMillis),
);
// #endregion model

// #region record
export const record = Effect.fnUntraced(function* (
  log: ReadonlyArray<TimedTransaction>,
  changes: ReadonlyArray<Change<TimedFact>>,
  recordedAt: number,
) {
  const last = log.at(-1)?.recordedAt ?? 0;
  if (!Number.isFinite(recordedAt) || recordedAt < last) {
    return yield* new StoreError({
      message: "recorded clock must not move backwards",
    });
  }
  for (const change of changes) {
    if (change.op !== "assert") continue;
    const { id, validFrom, validTo } = change.fact;
    if (
      !Number.isFinite(validFrom) ||
      validFrom < 0 ||
      (validTo !== undefined &&
        (!Number.isFinite(validTo) || validTo <= validFrom))
    ) {
      return yield* new StoreError({
        message: `invalid valid interval: ${id}`,
      });
    }
  }
  const tx = yield* stage(log, changes);
  return { ...tx, recordedAt };
});
// #endregion record

// #region read
export const readAt = (
  log: ReadonlyArray<TimedTransaction>,
  pattern: Pattern,
  basis: Basis,
) => {
  const known = log.filter(
    (tx) => tx.recordedAt <= basis.recordedAt,
  );
  return structuredClone(
    replay(known).filter(
      (fact) =>
        fact.validFrom <= basis.validAt &&
        (fact.validTo === undefined ||
          basis.validAt < fact.validTo) &&
        matches(fact, pattern),
    ),
  );
};
// #endregion read

// #region store
export const makeStore = (clock = wallClock) => {
  let log: ReadonlyArray<TimedTransaction> = [];
  const lock = Semaphore.makeUnsafe(1);

  const transact = (changes: ReadonlyArray<Change<TimedFact>>) =>
    lock.withPermit(
      Effect.gen(function* () {
        const now = yield* clock;
        const tx = yield* record(log, changes, now);
        log = [...log, tx];
        return structuredClone(tx);
      }),
    );

  const match = (pattern: Pattern, basis: Basis) =>
    Effect.sync(() => readAt(log, pattern, basis));

  const journal = Effect.sync(() => structuredClone(log));
  return { transact, match, journal };
};
// #endregion store
