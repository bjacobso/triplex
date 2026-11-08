// #region schemas
import { Effect, Schema, Semaphore } from "effect";
import type { Pattern, Value } from "../01/facts.ts";
import { StoreError, replay } from "../02/log.ts";
import { readAt, wallClock, type Basis } from "../03/temporal.ts";
import {
  accept,
  type Command,
  type Receipt,
} from "../04/commands.ts";

const Fact = Schema.Struct({
  id: Schema.String,
  entity: Schema.String,
  attribute: Schema.String,
  value: Schema.Union([
    Schema.String,
    Schema.Number,
    Schema.Boolean,
  ]),
  validFrom: Schema.Number,
  validTo: Schema.optionalKey(Schema.Number),
});

export const Changes = Schema.Array(
  Schema.Union([
    Schema.Struct({ op: Schema.Literal("assert"), fact: Fact }),
    Schema.Struct({
      op: Schema.Literal("retract"),
      id: Schema.String,
    }),
  ]),
);

export const Worker = Schema.Struct({
  ":entity/type": Schema.Literal("Worker"),
  ":worker/code": Schema.String,
  ":worker/trained": Schema.Boolean,
});
// #endregion schemas

// #region entity
export const checkEntities = Effect.fnUntraced(function* (
  facts: ReturnType<typeof replay>,
) {
  const entities = new Map<string, Record<string, Value>>();
  for (const { entity, attribute, value } of facts) {
    const body =
      entities.get(entity) ??
      (Object.create(null) as Record<string, Value>);
    if (Object.hasOwn(body, attribute)) {
      return yield* new StoreError({
        message: `multiple values: ${entity} ${attribute}`,
      });
    }
    body[attribute] = value;
    entities.set(entity, body);
  }
  const codes = new Set<string>();
  for (const body of entities.values()) {
    const worker = yield* Schema.decodeUnknownEffect(Worker)(body, {
      onExcessProperty: "error",
    });
    const code = worker[":worker/code"];
    if (codes.has(code)) {
      return yield* new StoreError({
        message: `worker code already used: ${code}`,
      });
    }
    codes.add(code);
  }
});
// #endregion entity

// #region boundaries
export const checkTimeline = Effect.fnUntraced(function* (
  log: ReadonlyArray<Receipt>,
) {
  const boundaries = new Set(
    replay(log).flatMap((fact) =>
      fact.validTo === undefined
        ? [fact.validFrom]
        : [fact.validFrom, fact.validTo],
    ),
  );
  const recordedAt = log.at(-1)?.recordedAt ?? 0;
  for (const validAt of [...boundaries].sort((a, b) => a - b)) {
    const facts = readAt(log, {}, { validAt, recordedAt });
    yield* checkEntities(facts);
  }
});
// #endregion boundaries

// #region store
export const makeStore = (clock = wallClock) => {
  let log: ReadonlyArray<Receipt> = [];
  const lock = Semaphore.makeUnsafe(1);

  const transact = (command: Command, input: unknown) =>
    lock.withPermit(
      Effect.gen(function* () {
        const changes = yield* Schema.decodeUnknownEffect(Changes)(
          input,
          { onExcessProperty: "error" },
        );
        const now = yield* clock;
        const receipt = yield* accept(log, command, changes, now);
        const proposed = [...log, receipt];
        yield* checkTimeline(proposed);
        log = proposed;
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
