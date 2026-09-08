import type { Triple, TripleInput } from "../Triple.js";
import { TxAttributes } from "../utils/id.js";
import type { TransactionChange, TransactionMeta, TransactionRecord } from "./Triples.js";
import { Option } from "effect";
import { EntityId, TransactionId, TripleId, unsafe } from "../Branded.js";

const text = (value: string) => ({ type: "string" as const, value });

export const transactionChangeFromTriple = (
  op: "assert" | "retract",
  triple: Triple,
  transactionId: TransactionId,
  transactionInstant: number,
): TransactionChange => ({
  op,
  tripleId: triple.id,
  entityId: triple.entityId,
  attribute: triple.attribute,
  ...(Option.isSome(triple.entityType) ? { entityType: triple.entityType.value } : {}),
  value: triple.value,
  validFrom: triple.validFrom,
  ...(Option.isSome(triple.validTo) ? { validTo: triple.validTo.value } : {}),
  recordedAt: triple.recordedAt,
  ...(op === "retract" ? { retractedAt: transactionInstant } : {}),
  ...(Option.isSome(triple.txId) ? { assertionTxId: triple.txId.value } : {}),
  ...(op === "retract" ? { retractionTxId: transactionId } : {}),
});

export const metadataInputs = (
  txId: TransactionId,
  position: number,
  instant: number,
  meta: TransactionMeta | undefined,
  changes: readonly TransactionChange[],
): readonly TripleInput[] => {
  const input = (attribute: string, value: TripleInput["value"]): TripleInput => ({
    entityId: txId,
    attribute,
    value,
    entityType: "_Transaction",
  });
  return [
    input(TxAttributes.POSITION, { type: "number", value: position }),
    input(TxAttributes.INSTANT, { type: "datetime", value: instant }),
    ...(meta?.actor ? [input(TxAttributes.ACTOR, text(meta.actor))] : []),
    ...(meta?.commandId ? [input(TxAttributes.COMMAND_ID, text(meta.commandId))] : []),
    ...(meta?.correlationId ? [input(TxAttributes.CORRELATION_ID, text(meta.correlationId))] : []),
    ...(meta?.causationId ? [input(TxAttributes.CAUSATION_ID, text(meta.causationId))] : []),
    ...(meta?.configSnapshot
      ? [input(TxAttributes.CONFIG_SNAPSHOT, text(meta.configSnapshot))]
      : []),
    ...[...new Set(changes.map((change) => change.entityId))].map((entityId) =>
      input(TxAttributes.CHANGED_ENTITY, { type: "ref", value: entityId }),
    ),
    ...changes.map((change) => input(TxAttributes.CHANGE, { type: "json", value: change })),
  ];
};

const scalar = (triple: Triple | undefined): string | undefined => {
  if (!triple) return undefined;
  return triple.value.type === "string" || triple.value.type === "ref"
    ? triple.value.value
    : undefined;
};

const decodeChange = (value: unknown): TransactionChange | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("op" in value) ||
    !("tripleId" in value) ||
    !("entityId" in value) ||
    !("attribute" in value)
  ) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    (candidate["op"] !== "assert" && candidate["op"] !== "retract") ||
    typeof candidate["tripleId"] !== "string" ||
    typeof candidate["entityId"] !== "string" ||
    typeof candidate["attribute"] !== "string" ||
    (candidate["assertionTxId"] !== undefined && typeof candidate["assertionTxId"] !== "string") ||
    (candidate["retractionTxId"] !== undefined && typeof candidate["retractionTxId"] !== "string")
  ) {
    return undefined;
  }
  try {
    return {
      ...(candidate as unknown as TransactionChange),
      tripleId: TripleId.make(candidate["tripleId"]),
      entityId: EntityId.make(candidate["entityId"]),
      ...(typeof candidate["assertionTxId"] === "string"
        ? { assertionTxId: TransactionId.make(candidate["assertionTxId"]) }
        : {}),
      ...(typeof candidate["retractionTxId"] === "string"
        ? { retractionTxId: TransactionId.make(candidate["retractionTxId"]) }
        : {}),
    };
  } catch {
    return undefined;
  }
};

export const transactionRecordFromTriples = (
  txId: TransactionId,
  triples: readonly Triple[],
): TransactionRecord | null => {
  const at = (attribute: string) => triples.find((triple) => triple.attribute === attribute);
  const instantTriple = at(TxAttributes.INSTANT);
  const positionTriple = at(TxAttributes.POSITION);
  if (
    !instantTriple ||
    instantTriple.value.type !== "datetime" ||
    !positionTriple ||
    positionTriple.value.type !== "number" ||
    !Number.isSafeInteger(positionTriple.value.value) ||
    positionTriple.value.value < 1
  ) {
    return null;
  }
  const changes = triples
    .filter((triple) => triple.attribute === TxAttributes.CHANGE && triple.value.type === "json")
    .flatMap((triple) => {
      const change = decodeChange(triple.value.value);
      return change === undefined ? [] : [change];
    });
  return {
    txId,
    position: positionTriple.value.value,
    instant: instantTriple.value.value,
    ...(scalar(at(TxAttributes.ACTOR)) ? { actor: scalar(at(TxAttributes.ACTOR))! } : {}),
    ...(scalar(at(TxAttributes.COMMAND_ID))
      ? { commandId: scalar(at(TxAttributes.COMMAND_ID))! }
      : {}),
    ...(scalar(at(TxAttributes.CORRELATION_ID))
      ? { correlationId: scalar(at(TxAttributes.CORRELATION_ID))! }
      : {}),
    ...(scalar(at(TxAttributes.CAUSATION_ID))
      ? { causationId: scalar(at(TxAttributes.CAUSATION_ID))! }
      : {}),
    ...(scalar(at(TxAttributes.CONFIG_SNAPSHOT))
      ? { configSnapshot: scalar(at(TxAttributes.CONFIG_SNAPSHOT))! }
      : {}),
    changes,
  };
};

export const transactionRecordsFromTriples = (
  triples: readonly Triple[],
): readonly TransactionRecord[] => {
  const grouped = new Map<TransactionId, Triple[]>();
  for (const triple of triples) {
    const txId = unsafe.transactionId(triple.entityId);
    const group = grouped.get(txId) ?? [];
    group.push(triple);
    grouped.set(txId, group);
  }
  return [...grouped.entries()]
    .flatMap(([txId, txTriples]) => {
      const record = transactionRecordFromTriples(txId, txTriples);
      return record === null ? [] : [record];
    })
    .sort((left, right) => left.position - right.position);
};

export const livePreconditionIds = (meta?: TransactionMeta): ReadonlySet<string> =>
  new Set(
    meta?.preconditions?.flatMap((condition) =>
      condition._tag === "TripleLive" ? [condition.id] : [],
    ) ?? [],
  );

export const entityStatePreconditions = (meta?: TransactionMeta) =>
  meta?.preconditions?.filter((condition) => condition._tag === "EntityState") ?? [];

export const invalidCommandId = (meta?: TransactionMeta): string | undefined => {
  const commandId = meta?.commandId;
  return commandId !== undefined && (commandId.length === 0 || commandId.length > 1_024)
    ? commandId
    : undefined;
};

export const validatePreconditions = (
  operations: readonly { readonly op: string; readonly id?: string }[],
  meta?: TransactionMeta,
): string | undefined => {
  const retractIds = new Set(
    operations.flatMap((operation) =>
      operation.op === "retract" && operation.id !== undefined ? [operation.id] : [],
    ),
  );
  const invalid = meta?.preconditions?.find(
    (condition) => condition._tag === "TripleLive" && !retractIds.has(condition.id),
  );
  return invalid?._tag === "TripleLive" ? invalid.id : undefined;
};
