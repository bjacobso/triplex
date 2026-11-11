/** Pure, guarded transaction builders for changes to a fact's valid interval. */
import { Option } from "effect";
import { validateAssertionBounds } from "./Triple.js";
import type { Triple, TransactAssertOp, TransactOp, TransactionPrecondition } from "./Triple.js";
import type { TripleValue } from "./Value.js";

export interface Change {
  readonly ops: ReadonlyArray<TransactOp>;
  readonly preconditions: ReadonlyArray<TransactionPrecondition>;
}

/** A split must leave a nonempty past and fall strictly before the original end. */
export class ChangeRangeError extends RangeError {
  readonly _tag = "ChangeRangeError";
  constructor(
    readonly factId: Triple["id"],
    readonly at: number,
  ) {
    super(
      `Cannot split fact ${factId} at ${at}: at must be finite and strictly inside its valid interval`,
    );
    this.name = "ChangeRangeError";
  }
}

const checkBounds = (fact: Triple) => {
  const invalid = validateAssertionBounds({
    validFrom: fact.validFrom,
    validTo: Option.getOrUndefined(fact.validTo),
  });
  if (invalid) throw invalid;
};
const assertion = (fact: Triple, value: TripleValue): TransactAssertOp => {
  checkBounds(fact);
  return {
    op: "assert",
    entityId: fact.entityId,
    attribute: fact.attribute,
    value,
    validFrom: fact.validFrom,
    ...(Option.isSome(fact.validTo) ? { validTo: fact.validTo.value } : {}),
    ...(Option.isSome(fact.entityType) ? { entityType: fact.entityType.value } : {}),
  };
};

/** End a fact at `at`, preserving its past. Throws ChangeRangeError for an invalid split. */
export const end = (fact: Triple, at: number): Change => {
  checkBounds(fact);
  const invalid = validateAssertionBounds({ validTo: at });
  if (invalid && Number.isFinite(at)) throw invalid;
  if (
    !Number.isFinite(at) ||
    at <= fact.validFrom ||
    (Option.isSome(fact.validTo) && at >= fact.validTo.value)
  ) {
    throw new ChangeRangeError(fact.id, at);
  }
  return {
    ops: [
      { op: "retract", id: fact.id },
      { ...assertion(fact, fact.value), validTo: at },
    ],
    preconditions: [{ _tag: "TripleLive", id: fact.id }],
  };
};

/** Replace from `at` until the original end. Throws ChangeRangeError for an invalid split. */
export const replace = (fact: Triple, value: TripleValue, at: number): Change => {
  const past = end(fact, at);
  return {
    ops: [...past.ops, { ...assertion(fact, value), validFrom: at }],
    preconditions: past.preconditions,
  };
};

/** Correct a value over its whole original interval, retaining recorded history. */
export const correct = (fact: Triple, value: TripleValue): Change => ({
  ops: [{ op: "retract", id: fact.id }, assertion(fact, value)],
  preconditions: [{ _tag: "TripleLive", id: fact.id }],
});

/** Concatenate independent changes in caller order for one transact call. */
export const combine = (...changes: ReadonlyArray<Change>): Change => ({
  ops: changes.flatMap((change) => change.ops),
  preconditions: changes.flatMap((change) => change.preconditions),
});
