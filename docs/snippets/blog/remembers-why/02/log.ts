// #region model
import { Effect, Schema, Semaphore } from "effect";
import type { Fact, Pattern } from "../01/facts.ts";

export type Assertion = Fact & { readonly id: string };

export type Change<A extends Assertion = Assertion> =
  | { readonly op: "assert"; readonly fact: A }
  | { readonly op: "retract"; readonly id: string };

export type Transaction<A extends Assertion = Assertion> = {
  readonly position: number;
  readonly changes: ReadonlyArray<Change<A>>;
};

export class StoreError extends Schema.TaggedError<StoreError>()(
  "StoreError",
  { message: Schema.String },
) {}
// #endregion model

// #region replay
export const replay = <A extends Assertion>(
  log: ReadonlyArray<Transaction<A>>,
) => {
  const live = new Map<string, A>();
  for (const tx of log) {
    for (const change of tx.changes) {
      if (change.op === "assert") {
        live.set(change.fact.id, change.fact);
      } else {
        live.delete(change.id);
      }
    }
  }
  return [...live.values()];
};

export const matches = (fact: Fact, pattern: Pattern) =>
  Object.entries(pattern).every(([key, value]) => {
    return fact[key as keyof Fact] === value;
  });
// #endregion replay

// #region stage
export const stage = Effect.fnUntraced(function* <
  A extends Assertion,
>(
  log: ReadonlyArray<Transaction<A>>,
  input: ReadonlyArray<Change<A>>,
) {
  const changes = structuredClone(input);
  const live = new Set(replay(log).map((fact) => fact.id));
  const used = new Set(
    log.flatMap((tx) =>
      tx.changes.flatMap((change) =>
        change.op === "assert" ? [change.fact.id] : [],
      ),
    ),
  );
  for (const change of changes) {
    if (change.op === "assert") {
      const id = change.fact.id;
      if (used.has(id)) {
        return yield* new StoreError({
          message: `assertion ID already used: ${id}`,
        });
      }
      used.add(id);
      live.add(id);
    } else {
      if (!live.delete(change.id)) {
        return yield* new StoreError({
          message: `assertion is not live: ${change.id}`,
        });
      }
    }
  }
  return { position: log.length + 1, changes };
});
// #endregion stage

// #region store
export const makeStore = () => {
  let log: ReadonlyArray<Transaction> = [];
  const lock = Semaphore.makeUnsafe(1);

  const transact = (changes: ReadonlyArray<Change>) =>
    lock.withPermit(
      Effect.gen(function* () {
        const tx = yield* stage(log, changes);
        log = [...log, tx];
        return structuredClone(tx);
      }),
    );

  const match = (pattern: Pattern) =>
    Effect.sync(() =>
      structuredClone(
        replay(log).filter((fact) => matches(fact, pattern)),
      ),
    );

  const journal = Effect.sync(() => structuredClone(log));
  return { transact, match, journal };
};
// #endregion store
