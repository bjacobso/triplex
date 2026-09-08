import { Encoding, Result } from "effect";

import type { TemporalBasis, ResolvedTemporalBasis } from "./Temporal.js";
import { resolveTemporalBasis } from "./Temporal.js";
import { PaginationCursorError } from "./errors/index.js";
import * as ContentId from "./content/ContentId.js";

export type EntityPageCursor = string & { readonly EntityPageCursor: unique symbol };

export interface EntityPageRequest {
  readonly entityType: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly basis?: TemporalBasis;
}

export interface EntityPageSnapshot {
  readonly recordedAt: number;
  readonly recordedPosition: number;
  readonly validAt: number;
}

interface CursorEnvelope extends EntityPageSnapshot {
  readonly version: 1;
  readonly scope: string;
  readonly entityType: string;
  readonly after: string;
}

export interface PreparedEntityPage {
  readonly entityType: string;
  readonly limit: number;
  readonly after?: string;
  readonly basis: ResolvedTemporalBasis & EntityPageSnapshot;
  readonly scope: string;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const cursorError = (message: string, cause?: unknown) =>
  new PaginationCursorError({
    reason: "malformed",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const decode = (cursor: string): CursorEnvelope => {
  try {
    const bytes = Encoding.decodeBase64Url(cursor);
    if (Result.isFailure(bytes)) throw bytes.failure;
    const value: unknown = JSON.parse(decoder.decode(bytes.success));
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      value.version !== 1 ||
      !("scope" in value) ||
      typeof value.scope !== "string" ||
      !("entityType" in value) ||
      typeof value.entityType !== "string" ||
      !("after" in value) ||
      typeof value.after !== "string" ||
      !("recordedAt" in value) ||
      typeof value.recordedAt !== "number" ||
      !("recordedPosition" in value) ||
      typeof value.recordedPosition !== "number" ||
      !("validAt" in value) ||
      typeof value.validAt !== "number" ||
      !Number.isFinite(value.recordedAt) ||
      !Number.isSafeInteger(value.recordedPosition) ||
      value.recordedPosition < 0 ||
      !Number.isFinite(value.validAt)
    ) {
      throw cursorError("Entity page cursor has an invalid shape");
    }
    return value as CursorEnvelope;
  } catch (cause) {
    if (cause instanceof PaginationCursorError) throw cause;
    throw cursorError("Entity page cursor is not valid base64url JSON", cause);
  }
};

const scopeFingerprint = (scope: string): string =>
  ContentId.hash(ContentId.Domain.paginationScope, `entity-page\u0000${scope}`);

export const prepareEntityPage = (input: {
  readonly request: EntityPageRequest;
  readonly now: number;
  readonly recordedPosition: number;
  readonly scope: string;
}): PreparedEntityPage => {
  const limit = input.request.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw cursorError("Entity page limit must be between 1 and 200");
  }
  if (input.request.entityType.length === 0) throw cursorError("Entity type must not be empty");
  const expectedScope = scopeFingerprint(input.scope);
  const envelope = input.request.cursor === undefined ? undefined : decode(input.request.cursor);
  if (envelope !== undefined) {
    if (envelope.scope !== expectedScope) {
      throw new PaginationCursorError({
        reason: "scope_mismatch",
        message: "Entity page cursor belongs to a different database scope",
      });
    }
    if (envelope.entityType !== input.request.entityType) {
      throw new PaginationCursorError({
        reason: "query_mismatch",
        message: "Entity page cursor belongs to a different entity type",
      });
    }
    if (input.request.basis !== undefined) {
      if (
        (input.request.basis.recordedAt !== undefined &&
          input.request.basis.recordedAt !== envelope.recordedAt) ||
        (input.request.basis.validAt !== undefined &&
          input.request.basis.validAt !== envelope.validAt)
      ) {
        throw new PaginationCursorError({
          reason: "basis_mismatch",
          message: "Entity page cursor cannot be reused with a different temporal basis",
        });
      }
    }
    return {
      entityType: input.request.entityType,
      limit,
      after: envelope.after,
      basis: {
        recordedAt: envelope.recordedAt,
        recordedPosition: envelope.recordedPosition,
        validAt: envelope.validAt,
      },
      scope: expectedScope,
    };
  }
  const requested = resolveTemporalBasis(input.request.basis, input.now);
  return {
    entityType: input.request.entityType,
    limit,
    basis: {
      recordedAt: requested.recordedAt ?? input.now,
      recordedPosition: input.recordedPosition,
      validAt: requested.validAt,
    },
    scope: expectedScope,
  };
};

export const encodeEntityPageCursor = (
  prepared: PreparedEntityPage,
  after: string,
): EntityPageCursor =>
  Encoding.encodeBase64Url(
    encoder.encode(
      JSON.stringify({
        version: 1,
        scope: prepared.scope,
        entityType: prepared.entityType,
        after,
        recordedAt: prepared.basis.recordedAt,
        recordedPosition: prepared.basis.recordedPosition,
        validAt: prepared.basis.validAt,
      } satisfies CursorEnvelope),
    ),
  ) as EntityPageCursor;
