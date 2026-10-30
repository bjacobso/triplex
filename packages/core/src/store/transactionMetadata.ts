import type { Triple, TripleInput } from "../Triple.js";
import { TxAttributes } from "../utils/id.js";
import type {
  TransactionChange,
  TransactionMeta,
  TransactionRecord,
  TransactionSummary,
} from "./Triples.js";
import { Option } from "effect";
import { EntityId, TransactionId, TripleId, unsafe } from "../Branded.js";
import * as CanonicalJson from "../content/CanonicalJson.js";
import * as ContentIds from "../content/ContentId.js";

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

const canonicalValue = (value: TransactionChange["value"]): CanonicalJson.CanonicalValue =>
  value === undefined
    ? null
    : (value.type === "number" || value.type === "datetime") && !Number.isFinite(value.value)
      ? { type: value.type, value: String(value.value) }
      : (value as unknown as CanonicalJson.CanonicalValue);

/** The compact journal entry for `changes`; see `TransactionSummary`. */
export const transactionSummary = (changes: readonly TransactionChange[]): TransactionSummary => {
  let asserted = 0;
  const attributes = new Set<string>();
  const content: CanonicalJson.CanonicalValue[] = [];
  for (const change of changes) {
    attributes.add(change.attribute);
    if (change.op === "assert") {
      asserted++;
      content.push([
        change.entityId,
        change.attribute,
        canonicalValue(change.value),
        change.validFrom ?? null,
        change.validTo ?? null,
        change.entityType ?? null,
      ]);
    } else {
      content.push(["retract", change.tripleId]);
    }
  }
  return {
    asserted,
    retracted: changes.length - asserted,
    attributes: [...attributes].sort(),
    digest: ContentIds.hash(
      ContentIds.Domain.transactionSummary,
      CanonicalJson.encodeOrThrow(content),
    ),
  };
};

export const metadataInputs = (
  txId: TransactionId,
  position: number,
  instant: number,
  meta: TransactionMeta | undefined,
  changes: readonly TransactionChange[],
  summary?: TransactionSummary,
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
    ...(meta?.journal === "summary"
      ? [
          input(TxAttributes.SUMMARY, {
            type: "json",
            value: summary ?? transactionSummary(changes),
          }),
        ]
      : changes.map((change) => input(TxAttributes.CHANGE, { type: "json", value: change }))),
  ];
};

const decodeSummary = (value: unknown): TransactionSummary | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const count = (field: unknown): field is number =>
    typeof field === "number" && Number.isSafeInteger(field) && field >= 0;
  return count(candidate["asserted"]) &&
    count(candidate["retracted"]) &&
    Array.isArray(candidate["attributes"]) &&
    candidate["attributes"].every((attribute) => typeof attribute === "string") &&
    typeof candidate["digest"] === "string" &&
    (candidate["segments"] === undefined ||
      (Array.isArray(candidate["segments"]) &&
        candidate["segments"].every((segment) => typeof segment === "string")))
    ? {
        asserted: candidate["asserted"],
        retracted: candidate["retracted"],
        attributes: candidate["attributes"] as string[],
        digest: candidate["digest"],
        ...(candidate["segments"] === undefined
          ? {}
          : { segments: candidate["segments"] as string[] }),
      }
    : undefined;
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
  const summaryTriple = at(TxAttributes.SUMMARY);
  const summary =
    summaryTriple?.value.type === "json" ? decodeSummary(summaryTriple.value.value) : undefined;
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
    ...(summary === undefined ? {} : { summary }),
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

/**
 * True for a record whose journal is a summary alone, with no per-fact
 * changes: consumers that need changes fall back to the submitted operations.
 */
export const isSummaryOnly = (record: TransactionRecord): boolean =>
  record.summary !== undefined && record.changes.length === 0;

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
