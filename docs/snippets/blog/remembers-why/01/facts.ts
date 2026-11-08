// #region model
import { Effect } from "effect";

export type Value = string | number | boolean;

export type Fact = {
  readonly entity: string;
  readonly attribute: string;
  readonly value: Value;
};

export type Pattern = Partial<Fact>;
// #endregion model

// #region store
export const makeStore = () => {
  const facts = new Map<string, Fact>();

  const put = (fact: Fact) =>
    Effect.sync(() => {
      const key = JSON.stringify([fact.entity, fact.attribute]);
      facts.set(key, { ...fact });
    });

  const match = (pattern: Pattern) =>
    Effect.sync(() =>
      [...facts.values()]
        .filter((fact) =>
          Object.entries(pattern).every(([key, value]) => {
            return fact[key as keyof Fact] === value;
          }),
        )
        .map((fact) => ({ ...fact })),
    );

  return { put, match };
};
// #endregion store
