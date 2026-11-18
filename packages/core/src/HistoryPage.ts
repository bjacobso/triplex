import { Result } from "effect";
import { Base64Url } from "effect/encoding";

import { PaginationCursorError } from "./errors/index.js";
import * as ContentId from "./content/ContentId.js";

export type HistoryPageCursor = string & { readonly HistoryPageCursor: unique symbol };

export interface HistoryPageRequest {
  /** Only this attribute's assertions. Omit for every attribute of the entity. */
  readonly attribute?: string;
  /** Defaults to 100; maximum 1,000. */
  readonly limit?: number;
  /** Opaque continuation returned by the previous page of the same entity and attribute. */
  readonly cursor?: string;
  /**
   * Read history as recorded at this commit position. Defaults to the current head; a
   * position beyond the head reads the head. A continuation must repeat the first page's
   * value or omit it.
   */
  readonly recordedPosition?: number;
}

/** Where a history page resumes: after this assertion in (position, ID) order. */
export interface HistoryPageAfter {
  readonly position: number;
  readonly id: string;
}

interface CursorEnvelope {
  readonly version: 1;
  readonly scope: string;
  readonly entityId: string;
  readonly attribute: string | null;
  readonly snapshotPosition: number;
  readonly afterPosition: number;
  readonly afterId: string;
}

export interface PreparedHistoryPage {
  readonly entityId: string;
  readonly attribute?: string;
  readonly limit: number;
  readonly snapshotPosition: number;
  readonly after?: HistoryPageAfter;
  readonly scope: string;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const malformed = (message: string, cause?: unknown) =>
  new PaginationCursorError({
    reason: "malformed",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const isPosition = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const decode = (cursor: string): CursorEnvelope => {
  try {
    const bytes = Base64Url.decode(cursor);
    if (Result.isFailure(bytes)) throw bytes.failure;
    const value: unknown = JSON.parse(decoder.decode(bytes.success));
    if (typeof value !== "object" || value === null || !("version" in value))
      throw malformed("History page cursor has an invalid shape");
    if (value.version !== 1)
      throw new PaginationCursorError({
        reason: "unsupported_version",
        message: "History page cursor has an unsupported version",
      });
    const v = value as Partial<CursorEnvelope>;
    if (
      typeof v.scope !== "string" ||
      typeof v.entityId !== "string" ||
      (v.attribute !== null && typeof v.attribute !== "string") ||
      !isPosition(v.snapshotPosition) ||
      !isPosition(v.afterPosition) ||
      v.afterPosition > v.snapshotPosition ||
      typeof v.afterId !== "string"
    )
      throw malformed("History page cursor has an invalid shape");
    return v as CursorEnvelope;
  } catch (cause) {
    if (cause instanceof PaginationCursorError) throw cause;
    throw malformed("History page cursor is not valid base64url JSON", cause);
  }
};

const scopeFingerprint = (scope: string): string =>
  ContentId.hash(ContentId.Domain.paginationScope, `history-page\u0000${scope}`);

/**
 * Validate a history page request against the current head. Throws
 * `PaginationCursorError` for invalid limits, positions and cursors.
 */
export const prepareHistoryPage = (input: {
  readonly entityId: string;
  readonly request: HistoryPageRequest;
  readonly recordedPosition: number;
  readonly scope: string;
}): PreparedHistoryPage => {
  const { request } = input;
  const limit = request.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
    throw malformed("History page limit must be between 1 and 1000");
  if (request.recordedPosition !== undefined && !isPosition(request.recordedPosition))
    throw malformed("History page recordedPosition must be a non-negative safe integer");
  if (request.attribute !== undefined && typeof request.attribute !== "string")
    throw malformed("History page attribute must be a string");
  const scope = scopeFingerprint(input.scope);
  const base = {
    entityId: input.entityId,
    ...(request.attribute === undefined ? {} : { attribute: request.attribute }),
    limit,
    scope,
  };
  if (request.cursor === undefined)
    return {
      ...base,
      snapshotPosition: Math.min(
        request.recordedPosition ?? input.recordedPosition,
        input.recordedPosition,
      ),
    };
  const envelope = decode(request.cursor);
  if (envelope.scope !== scope)
    throw new PaginationCursorError({
      reason: "scope_mismatch",
      message: "History page cursor belongs to a different database scope",
    });
  if (envelope.entityId !== input.entityId || envelope.attribute !== (request.attribute ?? null))
    throw new PaginationCursorError({
      reason: "query_mismatch",
      message: "History page cursor belongs to a different entity or attribute",
    });
  if (
    request.recordedPosition !== undefined &&
    Math.min(request.recordedPosition, input.recordedPosition) !== envelope.snapshotPosition
  )
    throw new PaginationCursorError({
      reason: "basis_mismatch",
      message: "History page cursor cannot be reused with a different recordedPosition",
    });
  if (envelope.snapshotPosition > input.recordedPosition)
    throw new PaginationCursorError({
      reason: "basis_mismatch",
      message: "History page cursor is ahead of this database's committed head",
    });
  return {
    ...base,
    snapshotPosition: envelope.snapshotPosition,
    after: { position: envelope.afterPosition, id: envelope.afterId },
  };
};

export const encodeHistoryPageCursor = (
  prepared: PreparedHistoryPage,
  after: HistoryPageAfter,
): HistoryPageCursor =>
  Base64Url.encode(
    encoder.encode(
      JSON.stringify({
        version: 1,
        scope: prepared.scope,
        entityId: prepared.entityId,
        attribute: prepared.attribute ?? null,
        snapshotPosition: prepared.snapshotPosition,
        afterPosition: after.position,
        afterId: after.id,
      } satisfies CursorEnvelope),
    ),
  ) as HistoryPageCursor;
