// #region model
import { Effect, Semaphore } from "effect";
import type { Pattern } from "../01/facts.ts";
import { StoreError, type Change } from "../02/log.ts";
import {
  readAt,
  record,
  wallClock,
  type Basis,
  type TimedFact,
  type TimedTransaction,
} from "../03/temporal.ts";

export type Command = {
  readonly id: string;
  readonly actor: string;
  readonly rules: string;
};

export type Receipt = TimedTransaction & {
  readonly command: Command;
};
// #endregion model

// #region accept
export const accept = Effect.fnUntraced(function* (
  log: ReadonlyArray<Receipt>,
  command: Command,
  changes: ReadonlyArray<Change<TimedFact>>,
  now: number,
) {
  const existing = log.find((tx) => tx.command.id === command.id);
  if (existing !== undefined) {
    return yield* new StoreError({
      message: `command already committed: ${command.id}`,
    });
  }
  const tx = yield* record(log, changes, now);
  return { ...tx, command: structuredClone(command) };
});
// #endregion accept

// #region store
export const makeStore = (clock = wallClock) => {
  let log: ReadonlyArray<Receipt> = [];
  const lock = Semaphore.makeUnsafe(1);

  const transact = (
    command: Command,
    changes: ReadonlyArray<Change<TimedFact>>,
  ) =>
    lock.withPermit(
      Effect.gen(function* () {
        const now = yield* clock;
        const receipt = yield* accept(log, command, changes, now);
        log = [...log, receipt];
        return structuredClone(receipt);
      }),
    );

  const receipt = (id: string) =>
    Effect.sync(() =>
      structuredClone(log.find((tx) => tx.command.id === id)),
    );

  const match = (pattern: Pattern, basis: Basis) =>
    Effect.sync(() => readAt(log, pattern, basis));

  const journal = Effect.sync(() => structuredClone(log));
  return { transact, receipt, match, journal };
};
// #endregion store
