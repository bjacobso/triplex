import { Effect, Result } from "effect";
import { Base64Url } from "effect/encoding";
import * as CanonicalJson from "../content/CanonicalJson.js";
import * as ContentIds from "../content/ContentId.js";
import {
  ReadError,
  WriteError,
  PaginationCursorError,
  OperationalEntryConflictError,
} from "../errors/index.js";
import type { TransactionId } from "../Branded.js";
import type { StorageAdapterService } from "../storage/StorageAdapter.js";
import type {
  AcknowledgeEntryOp,
  AppendEntryOp,
  EntryKind,
  OperationalEntry,
  OperationalEntryRecord,
  PendingEntriesRequest,
  PendingEntriesScan,
} from "./Entry.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const entryId = (kind: EntryKind, scope: string, key: string) =>
  ContentIds.hash(
    ContentIds.Domain.operationalEntry,
    CanonicalJson.encodeOrThrow([kind, scope, key]),
  );
const scopeToken = (scope: string) =>
  ContentIds.hash(ContentIds.Domain.operationalScope, CanonicalJson.encodeOrThrow(scope));
const validPosition = (value: number) => Number.isSafeInteger(value) && value > 0;

export const decodeEntry = (
  record: OperationalEntryRecord,
): Effect.Effect<OperationalEntry, ReadError> =>
  Effect.try({
    try: () => {
      if (
        (record.kind !== "inbox" && record.kind !== "outbox") ||
        typeof record.scope !== "string" ||
        record.scope.length === 0 ||
        typeof record.idempotencyKey !== "string" ||
        record.idempotencyKey.length === 0 ||
        record.id !== entryId(record.kind, record.scope, record.idempotencyKey) ||
        record.scopeToken !== scopeToken(record.scope) ||
        !validPosition(record.recordedPosition) ||
        !Number.isFinite(record.recordedAt) ||
        record.recordedAt < 0 ||
        typeof record.txId !== "string"
      )
        throw new Error("Invalid operational entry metadata");
      const ack = [record.acknowledgedPosition, record.acknowledgedAt, record.acknowledgedTxId];
      if (
        ack.some((v) => v !== undefined) &&
        (ack.some((v) => v === undefined) ||
          !validPosition(record.acknowledgedPosition!) ||
          record.acknowledgedPosition! < record.recordedPosition ||
          !Number.isFinite(record.acknowledgedAt) ||
          record.acknowledgedAt! < 0 ||
          typeof record.acknowledgedTxId !== "string")
      )
        throw new Error("Invalid operational acknowledgement metadata");
      const payload: CanonicalJson.CanonicalValue = JSON.parse(record.payload);
      if (CanonicalJson.encodeOrThrow(payload) !== record.payload)
        throw new Error("Non-canonical stored operational payload");
      const { scopeToken: _scopeToken, ...entry } = record;
      return { ...entry, payload };
    },
    catch: (cause) => new ReadError({ message: "Invalid stored operational entry", cause }),
  });

type EntryMutationPort = Pick<
  StorageAdapterService,
  "getOperationalEntry" | "insertOperationalEntry" | "acknowledgeOperationalEntry"
>;
export const applyEntryOperation = (
  op: AppendEntryOp | AcknowledgeEntryOp,
  port: EntryMutationPort,
  meta: { readonly txId: TransactionId; readonly position: number; readonly instant: number },
) =>
  Effect.gen(function* () {
    if (!validPosition(meta.position) || !Number.isFinite(meta.instant) || meta.instant < 0)
      return yield* new WriteError({ message: "Invalid operational transaction metadata" });
    if (op.kind !== "inbox" && op.kind !== "outbox")
      return yield* new WriteError({ message: "Invalid operational entry kind" });
    if (op.op === "append-entry") {
      if (
        typeof op.scope !== "string" ||
        op.scope.length === 0 ||
        typeof op.idempotencyKey !== "string" ||
        op.idempotencyKey.length === 0 ||
        op.idempotencyKey.length > 1024
      )
        return yield* new WriteError({
          message:
            "Operational scope must be non-empty and idempotency key must contain 1..1024 characters",
        });
      const payload = yield* CanonicalJson.encode(op.payload as CanonicalJson.CanonicalValue).pipe(
        Effect.mapError(
          (cause) => new WriteError({ message: "Invalid operational payload", cause }),
        ),
      );
      const id = entryId(op.kind, op.scope, op.idempotencyKey);
      const existing = yield* port.getOperationalEntry(id);
      if (existing !== null) {
        yield* decodeEntry(existing);
        if (
          existing.kind !== op.kind ||
          existing.scope !== op.scope ||
          existing.idempotencyKey !== op.idempotencyKey ||
          existing.payload !== payload
        )
          return yield* new OperationalEntryConflictError({
            entryId: id,
            kind: op.kind,
            scope: op.scope,
            idempotencyKey: op.idempotencyKey,
            message: "Operational idempotency key already has a different payload",
          });
        return;
      }
      yield* port.insertOperationalEntry({
        id,
        kind: op.kind,
        scope: op.scope,
        scopeToken: scopeToken(op.scope),
        idempotencyKey: op.idempotencyKey,
        payload,
        recordedPosition: meta.position,
        recordedAt: meta.instant,
        txId: meta.txId,
      });
    } else {
      if (!ContentIds.isContentId(op.id))
        return yield* new WriteError({ message: "Invalid operational entry ID" });
      const existing = yield* port.getOperationalEntry(op.id);
      if (existing === null || existing.kind !== op.kind)
        return yield* new WriteError({
          message: "Operational entry does not exist in this inbox/outbox",
        });
      yield* decodeEntry(existing);
      if (existing.acknowledgedPosition === undefined)
        yield* port.acknowledgeOperationalEntry(op.id, meta.position, meta.instant, meta.txId);
    }
  });

interface PreparedPending {
  readonly scan: PendingEntriesScan;
  readonly limit: number;
  readonly database: string;
  readonly filter: string;
}
const invalidCursor = (
  message: string,
  reason: "malformed" | "scope_mismatch" | "query_mismatch" = "malformed",
) => new PaginationCursorError({ reason, message });
export const preparePendingEntries = (
  kind: EntryKind,
  request: PendingEntriesRequest,
  databaseScope: string,
): PreparedPending => {
  const limit = request.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw invalidCursor("Pending entry limit must be 1..1000");
  if (kind !== "inbox" && kind !== "outbox") throw invalidCursor("Invalid inbox/outbox kind");
  if (
    request.scope !== undefined &&
    (typeof request.scope !== "string" || request.scope.length === 0)
  )
    throw invalidCursor("Operational scope must be non-empty");
  const token = request.scope === undefined ? undefined : scopeToken(request.scope);
  const database = ContentIds.hash(
    ContentIds.Domain.paginationScope,
    `operational\0${databaseScope}`,
  );
  const filter = ContentIds.hash(
    ContentIds.Domain.operationalCursor,
    CanonicalJson.encodeOrThrow([kind, token ?? null]),
  );
  let after: PendingEntriesScan["after"];
  if (request.cursor !== undefined) {
    let value: unknown;
    try {
      const decoded = Base64Url.decode(request.cursor);
      if (Result.isFailure(decoded)) throw decoded.failure;
      value = JSON.parse(decoder.decode(decoded.success));
    } catch {
      throw invalidCursor("Invalid operational cursor encoding");
    }
    if (
      typeof value !== "object" ||
      value === null ||
      !("v" in value) ||
      value.v !== 1 ||
      !("database" in value) ||
      !("filter" in value) ||
      !("recordedPosition" in value) ||
      typeof value.recordedPosition !== "number" ||
      !validPosition(value.recordedPosition) ||
      !("id" in value) ||
      !ContentIds.isContentId(value.id)
    )
      throw invalidCursor("Invalid operational cursor shape");
    if (value.database !== database)
      throw invalidCursor("Operational cursor belongs to another database", "scope_mismatch");
    if (value.filter !== filter)
      throw invalidCursor(
        "Operational cursor belongs to another scope or direction",
        "query_mismatch",
      );
    after = { recordedPosition: value.recordedPosition, id: value.id };
  }
  return {
    limit,
    database,
    filter,
    scan: {
      kind,
      limit: limit + 1,
      ...(token === undefined ? {} : { scopeToken: token }),
      ...(after === undefined ? {} : { after }),
    },
  };
};
export const finishPendingEntries = (
  prepared: PreparedPending,
  records: readonly OperationalEntryRecord[],
) =>
  Effect.gen(function* () {
    if (
      records.length > prepared.scan.limit ||
      records.some(
        (record) =>
          record.kind !== prepared.scan.kind ||
          record.acknowledgedPosition !== undefined ||
          (prepared.scan.scopeToken !== undefined &&
            record.scopeToken !== prepared.scan.scopeToken),
      )
    )
      return yield* new ReadError({ message: "Invalid operational pending index result" });
    const selected = records.slice(0, prepared.limit);
    const entries = yield* Effect.forEach(selected, decodeEntry);
    const last = selected.at(-1);
    return {
      entries,
      ...(last !== undefined && records.length > prepared.limit
        ? {
            nextCursor: Base64Url.encode(
              encoder.encode(
                JSON.stringify({
                  v: 1,
                  database: prepared.database,
                  filter: prepared.filter,
                  recordedPosition: last.recordedPosition,
                  id: last.id,
                }),
              ),
            ),
          }
        : {}),
    };
  });
