import { Effect, Schema } from "effect";
import { TripleValue } from "./Value.js";
import { TripleId, EntityId, Attribute, TransactionId } from "./Branded.js";
import { RuleSchema as ConstraintRule } from "./Constraint.js";
import { AppendEntryOp, AcknowledgeEntryOp } from "./operational/Entry.js";

export { TripleId, EntityId, Attribute };

import { ValidationError, WriteError } from "./errors/index.js";

/** Stored valid-time bounds use integer epoch milliseconds on every backend. */
export const ValidTimeBound = Schema.Number.pipe(
  Schema.check(
    Schema.makeFilter(Number.isInteger, {
      expected: "integer epoch milliseconds",
    }),
  ),
);

/** Shared by assertion builders and the transaction boundary. */
export const validateAssertionBounds = (input: {
  readonly validFrom?: number | undefined;
  readonly validTo?: number | undefined;
}): ValidationError | undefined => {
  for (const field of ["validFrom", "validTo"] as const) {
    if (input[field] !== undefined && !Number.isInteger(input[field]))
      return new ValidationError({
        code: "time.invalid-bound",
        field,
        message: `${field} must be integer epoch milliseconds`,
      });
  }
  return undefined;
};

/** Validate every assertion before a transaction can mutate facts or its journal. */
export const validateTransactionIntervals = (
  operations: readonly TransactOp[],
): Effect.Effect<void, WriteError> =>
  Effect.gen(function* () {
    for (const operation of operations) {
      if (operation.op !== "assert") continue;
      const invalid = validateAssertionBounds(operation);
      if (invalid) return yield* new WriteError({ message: invalid.message, cause: invalid });
    }
  });

export const TripleInput = Schema.Struct({
  entityId: EntityId,
  attribute: Schema.String,
  value: TripleValue,
  entityType: Schema.optional(Schema.String),
  createdBy: Schema.optional(Schema.String),
  validFrom: Schema.optional(ValidTimeBound),
  validTo: Schema.optional(ValidTimeBound),
});
export type TripleInput = typeof TripleInput.Type;

export const QueryRequest = Schema.Struct({
  entityId: Schema.optional(EntityId),
  attribute: Schema.optional(Schema.String),
  entityType: Schema.optional(Schema.String),
  value: Schema.optional(TripleValue),
});
export type QueryRequest = typeof QueryRequest.Type;

export const QueryAsOfRequest = Schema.Struct({
  entityId: Schema.optional(EntityId),
  attribute: Schema.optional(Schema.String),
  entityType: Schema.optional(Schema.String),
  value: Schema.optional(TripleValue),
  asOf: Schema.Number,
});
export type QueryAsOfRequest = typeof QueryAsOfRequest.Type;

export const AssertTripleRequest = Schema.Union([TripleInput, Schema.Array(TripleInput)]);
export type AssertTripleRequest = typeof AssertTripleRequest.Type;

export const RetractResponse = Schema.Struct({ retracted: Schema.Number });
export type RetractResponse = typeof RetractResponse.Type;

export const TripleResponse = Schema.Struct({
  id: TripleId,
  entityId: EntityId,
  attribute: Schema.String,
  value: TripleValue,
  recordedAt: Schema.Number,
  validFrom: Schema.Number,
  validTo: Schema.NullOr(Schema.Number),
  createdBy: Schema.NullOr(Schema.String),
  retractedAt: Schema.NullOr(Schema.Number),
  entityType: Schema.NullOr(Schema.String),
  schemaVersion: Schema.NullOr(Schema.Number),
  txId: Schema.NullOr(TransactionId),
  retractTxId: Schema.NullOr(TransactionId),
});
export type TripleResponse = typeof TripleResponse.Type;

export const Triple = Schema.Struct({
  id: TripleId,
  entityId: EntityId,
  attribute: Attribute,
  value: TripleValue,
  recordedAt: Schema.Number,
  validFrom: Schema.Number,
  validTo: Schema.OptionFromOptional(Schema.Number),
  createdBy: Schema.OptionFromOptional(Schema.String),
  retractedAt: Schema.OptionFromOptional(Schema.Number),
  entityType: Schema.OptionFromOptional(Schema.String),
  schemaVersion: Schema.OptionFromOptional(Schema.Number),
  txId: Schema.OptionFromOptional(TransactionId),
  retractTxId: Schema.OptionFromOptional(TransactionId),
});
export type Triple = typeof Triple.Type;

export const TripleRow = Schema.Struct({
  id: Schema.String,
  entity_id: Schema.String,
  attribute: Schema.String,
  value_type: Schema.String,
  value_string: Schema.NullOr(Schema.String),
  value_number: Schema.NullOr(Schema.Number),
  value_boolean: Schema.NullOr(Schema.Number),
  value_datetime: Schema.NullOr(Schema.Number),
  value_json: Schema.NullOr(Schema.String),
  /** Sealed-value envelope (`value_type = 'sealed'`); absent on pre-v3 rows. */
  value_sealed: Schema.optional(Schema.NullOr(Schema.String)),
  /** Blind-index token for a sealed value, when the codec provides one. */
  value_blind: Schema.optional(Schema.NullOr(Schema.String)),
  recorded_at: Schema.Number,
  recorded_position: Schema.Number,
  valid_from: Schema.Number,
  valid_to: Schema.NullOr(Schema.Number),
  created_by: Schema.NullOr(Schema.String),
  retracted_at: Schema.NullOr(Schema.Number),
  retracted_position: Schema.NullOr(Schema.Number),
  retract_tx_id: Schema.NullOr(Schema.String),
  entity_type: Schema.NullOr(Schema.String),
  schema_version: Schema.NullOr(Schema.Number),
  tx_id: Schema.NullOr(Schema.String),
});
export type TripleRow = typeof TripleRow.Type;

export const TransactAssertOp = Schema.Struct({
  op: Schema.Literal("assert"),
  entityId: EntityId,
  attribute: Schema.String,
  value: TripleValue,
  entityType: Schema.optional(Schema.String),
  createdBy: Schema.optional(Schema.String),
  validFrom: Schema.optional(ValidTimeBound),
  validTo: Schema.optional(ValidTimeBound),
});
export type TransactAssertOp = typeof TransactAssertOp.Type;

export const TransactRetractOp = Schema.Struct({
  op: Schema.Literal("retract"),
  id: TripleId,
});
export type TransactRetractOp = typeof TransactRetractOp.Type;

export const TransactRetractPatternOp = Schema.Struct({
  op: Schema.Literal("retract-pattern"),
  pattern: QueryRequest,
});
export type TransactRetractPatternOp = typeof TransactRetractPatternOp.Type;

export const TransactOp = Schema.Union([
  TransactAssertOp,
  TransactRetractOp,
  TransactRetractPatternOp,
  AppendEntryOp,
  AcknowledgeEntryOp,
]);
export type TransactOp = typeof TransactOp.Type;

export const TripleLivePrecondition = Schema.Struct({
  _tag: Schema.Literal("TripleLive"),
  id: TripleId,
});
export const EntityStatePrecondition = Schema.Struct({
  _tag: Schema.Literal("EntityState"),
  entityId: EntityId,
  /** The complete set of live fact identities observed before constructing the transaction. */
  tripleIds: Schema.Array(TripleId),
});
export const AttributeValuePrecondition = Schema.Struct({
  _tag: Schema.Literal("AttributeValue"),
  entityId: EntityId,
  attribute: Schema.String,
  value: TripleValue,
});
export const AttributeAbsentPrecondition = Schema.Struct({
  _tag: Schema.Literal("AttributeAbsent"),
  entityId: EntityId,
  attribute: Schema.String,
});
export const EntityAbsentPrecondition = Schema.Struct({
  _tag: Schema.Literal("EntityAbsent"),
  entityId: EntityId,
});
export const TransactionPrecondition = Schema.Union([
  AttributeValuePrecondition,
  AttributeAbsentPrecondition,
  EntityAbsentPrecondition,
  TripleLivePrecondition,
  EntityStatePrecondition,
]);
export type TransactionPrecondition = typeof TransactionPrecondition.Type;

export const TransactRequest = Schema.Struct({
  operations: Schema.Array(TransactOp),
  meta: Schema.optional(
    Schema.Struct({
      actor: Schema.optional(Schema.String),
      commandId: Schema.optional(Schema.String),
      correlationId: Schema.optional(Schema.String),
      causationId: Schema.optional(Schema.String),
      configSnapshot: Schema.optional(Schema.String),
      enforce: Schema.optional(Schema.Struct({ constraints: Schema.Array(ConstraintRule) })),
      preconditions: Schema.optional(Schema.Array(TransactionPrecondition)),
    }),
  ),
});
export type TransactRequest = typeof TransactRequest.Type;

export const TransactResponse = Schema.Struct({
  txId: TransactionId,
  asserted: Schema.Array(TripleResponse),
  retracted: Schema.Number,
});
export type TransactResponse = typeof TransactResponse.Type;

export const queryToPattern = (query: QueryRequest) => ({
  ...(query.entityId !== undefined && { entityId: query.entityId }),
  ...(query.attribute !== undefined && { attribute: query.attribute }),
  ...(query.entityType !== undefined && { entityType: query.entityType }),
  ...(query.value !== undefined && { value: query.value }),
});
