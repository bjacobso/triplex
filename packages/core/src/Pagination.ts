import { Encoding, Result, Schema } from "effect";

import type { WrappedQueryResult } from "./storage/QueryExecutor.js";
import type { DatalogQuery, OrderBySpec, WrappedQuery } from "./datalog/types.js";
import type { ResolvedTemporalBasis, TemporalBasis } from "./Temporal.js";
import { resolveTemporalBasis } from "./Temporal.js";
import { PaginationCursorError } from "./errors/index.js";
import * as CanonicalJson from "./content/CanonicalJson.js";
import * as ContentId from "./content/ContentId.js";

/** Public reads default to 100 rows and never exceed 1,000 rows per page. */
export const DEFAULT_QUERY_PAGE_SIZE = 100;
export const MAX_QUERY_PAGE_SIZE = 1_000;

/** Preserve the raw query's limit/offset as a logical subquery boundary. */
export const wrapDatalogQuery = (
  query: DatalogQuery,
  options?: { readonly pageSize?: number; readonly cursor?: string },
): WrappedQuery => ({
  inner: query,
  ...(query.orderBy === undefined ? {} : { orderBy: query.orderBy }),
  ...(options?.pageSize === undefined ? {} : { limit: options.pageSize }),
  ...(options?.cursor === undefined ? {} : { cursor: options.cursor }),
});

export type PaginationValue = string | number | boolean | null;

const PaginationValueSchema = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
]);

const PaginationCursorEnvelopeSchema = Schema.Struct({
  version: Schema.Number,
  queryFingerprint: Schema.String,
  scopeFingerprint: Schema.String,
  basis: Schema.Struct({
    recordedAt: Schema.Number,
    recordedPosition: Schema.Number,
    validAt: Schema.Number,
  }),
  values: Schema.Array(PaginationValueSchema),
});

interface PaginationCursorEnvelope {
  readonly version: number;
  readonly queryFingerprint: string;
  readonly scopeFingerprint: string;
  readonly basis: {
    readonly recordedAt: number;
    readonly recordedPosition: number;
    readonly validAt: number;
  };
  readonly values: readonly PaginationValue[];
}

export type PaginationCursor = string & { readonly PaginationCursor: unique symbol };

export interface PreparedPagination {
  readonly query: WrappedQuery;
  readonly logicalQuery: WrappedQuery;
  readonly basis: ResolvedTemporalBasis & {
    readonly recordedAt: number;
    readonly recordedPosition: number;
  };
  readonly orderBy: readonly OrderBySpec[];
  readonly cursorValues?: readonly PaginationValue[];
  readonly queryFingerprint: string;
  readonly scopeFingerprint: string;
  readonly pageSize: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const withoutCursor = (query: WrappedQuery): WrappedQuery => {
  const { cursor: _cursor, ...rest } = query;
  return rest;
};

const projectedVariables = (query: WrappedQuery): readonly string[] => {
  const variables: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.startsWith("?") && !variables.includes(value)) {
      variables.push(value);
    }
  };

  query.inner.find.forEach(add);
  query.inner.aggregate?.forEach(([, , target]) => add(target));
  query.inner.optionalProjection?.fields.forEach(({ variable }) => add(variable));
  return variables;
};

/**
 * Complete a caller's ordering with every projected variable. Datalog results
 * are set-valued, so the complete projected row is a deterministic unique
 * tie-breaker even when the caller's primary sort values are equal.
 */
export const normalizePaginationOrder = (query: WrappedQuery): readonly OrderBySpec[] => {
  const projected = projectedVariables(query);
  const order: OrderBySpec[] = [];

  for (const item of query.orderBy ?? []) {
    if (!projected.includes(item.variable)) {
      throw new PaginationCursorError({
        reason: "invalid_ordering",
        message: `Pagination order variable ${item.variable} is not projected by the query`,
      });
    }
    if (!order.some(({ variable }) => variable === item.variable)) order.push(item);
  }

  for (const variable of projected) {
    if (!order.some((item) => item.variable === variable)) {
      order.push({ variable, direction: "asc" });
    }
  }

  return order;
};

const queryFingerprint = (
  query: WrappedQuery,
  basis: ResolvedTemporalBasis & {
    readonly recordedAt: number;
    readonly recordedPosition: number;
  },
): string =>
  ContentId.hash(
    ContentId.Domain.paginationCursor,
    CanonicalJson.encodeOrThrow({
      query: query as unknown as CanonicalJson.CanonicalValue,
      basis: {
        recordedAt: basis.recordedAt,
        recordedPosition: basis.recordedPosition,
        validAt: basis.validAt,
      },
    }),
  );

const scopeFingerprint = (scope: string): string =>
  ContentId.hash(ContentId.Domain.paginationScope, scope);

const decodeEnvelope = (cursor: string): PaginationCursorEnvelope => {
  let unknown: unknown;
  try {
    const decoded = Encoding.decodeBase64Url(cursor);
    if (Result.isFailure(decoded)) throw decoded.failure;
    unknown = JSON.parse(textDecoder.decode(decoded.success));
  } catch (cause) {
    throw new PaginationCursorError({
      reason: "malformed",
      message: "Pagination cursor is not valid base64url JSON",
      cause,
    });
  }

  const result = Schema.decodeUnknownResult(PaginationCursorEnvelopeSchema)(unknown);
  if (Result.isFailure(result)) {
    throw new PaginationCursorError({
      reason: "malformed",
      message: `Pagination cursor has an invalid shape: ${result.failure.message}`,
      cause: result.failure,
    });
  }
  if (result.success.version !== 1) {
    throw new PaginationCursorError({
      reason: "unsupported_version",
      message: `Unsupported pagination cursor version ${result.success.version}`,
    });
  }
  const { basis, values } = result.success;
  if (
    !Number.isFinite(basis.recordedAt) ||
    basis.recordedAt < 0 ||
    !Number.isFinite(basis.validAt) ||
    basis.validAt < 0 ||
    !Number.isSafeInteger(basis.recordedPosition) ||
    basis.recordedPosition < 0 ||
    values.some((value) => typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new PaginationCursorError({
      reason: "malformed",
      message: "Pagination cursor contains an invalid temporal basis or ordering value",
    });
  }
  return result.success;
};

export const preparePagination = (input: {
  readonly query: WrappedQuery;
  readonly basis?: TemporalBasis;
  readonly now: number;
  readonly recordedPosition: number;
  readonly scope: string;
}): PreparedPagination => {
  if (!Number.isSafeInteger(input.recordedPosition) || input.recordedPosition < 0) {
    throw new PaginationCursorError({
      reason: "malformed",
      message: "Pagination requires a non-negative safe commit position",
    });
  }
  const pageSize = input.query.limit ?? DEFAULT_QUERY_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_QUERY_PAGE_SIZE) {
    throw new PaginationCursorError({
      reason: "malformed",
      message: `Query page size must be an integer between 1 and ${MAX_QUERY_PAGE_SIZE}`,
    });
  }
  const orderBy = normalizePaginationOrder(input.query);
  const inner = input.query.inner;
  const stableInner =
    inner.limit === undefined && inner.offset === undefined
      ? inner
      : {
          ...inner,
          orderBy: normalizePaginationOrder({
            inner,
            ...(inner.orderBy === undefined ? {} : { orderBy: inner.orderBy }),
          }),
        };
  const baseQuery = withoutCursor({
    ...input.query,
    inner: stableInner,
    limit: pageSize,
    orderBy: [...orderBy],
  });
  const envelope =
    input.query.cursor === undefined ? undefined : decodeEnvelope(input.query.cursor);

  let basis: ResolvedTemporalBasis & {
    readonly recordedAt: number;
    readonly recordedPosition: number;
  };
  if (envelope !== undefined) {
    basis = envelope.basis;
    if (input.basis !== undefined) {
      const requested = input.basis;
      if (
        (requested.recordedAt !== undefined && requested.recordedAt !== basis.recordedAt) ||
        (requested.validAt !== undefined && requested.validAt !== basis.validAt)
      ) {
        throw new PaginationCursorError({
          reason: "basis_mismatch",
          message: "Pagination cursor cannot be reused with a different temporal basis",
        });
      }
    }
  } else {
    const resolved = resolveTemporalBasis(input.basis, input.now);
    basis = {
      recordedAt: resolved.recordedAt ?? input.now,
      recordedPosition: input.recordedPosition,
      validAt: resolved.validAt,
    };
  }

  const expectedQueryFingerprint = queryFingerprint(baseQuery, basis);
  const expectedScopeFingerprint = scopeFingerprint(input.scope);
  if (envelope !== undefined && envelope.scopeFingerprint !== expectedScopeFingerprint) {
    throw new PaginationCursorError({
      reason: "scope_mismatch",
      message: "Pagination cursor belongs to a different database scope",
    });
  }
  if (envelope !== undefined && envelope.queryFingerprint !== expectedQueryFingerprint) {
    throw new PaginationCursorError({
      reason: "query_mismatch",
      message: "Pagination cursor belongs to a different query",
    });
  }
  if (envelope !== undefined && envelope.values.length !== orderBy.length) {
    throw new PaginationCursorError({
      reason: "malformed",
      message: "Pagination cursor does not contain the complete deterministic ordering key",
    });
  }

  const query: WrappedQuery = {
    ...baseQuery,
    limit: pageSize + 1,
  };

  return {
    query,
    logicalQuery: baseQuery,
    basis,
    orderBy,
    ...(envelope === undefined ? {} : { cursorValues: envelope.values }),
    queryFingerprint: expectedQueryFingerprint,
    scopeFingerprint: expectedScopeFingerprint,
    pageSize,
  };
};

const encodeEnvelope = (envelope: PaginationCursorEnvelope): PaginationCursor =>
  Encoding.encodeBase64Url(textEncoder.encode(JSON.stringify(envelope))) as PaginationCursor;

export const finishPagination = (
  prepared: PreparedPagination,
  result: WrappedQueryResult,
): WrappedQueryResult => {
  if (result.results.length <= prepared.pageSize) return result;

  const results = result.results.slice(0, prepared.pageSize);
  const last = results.at(-1)!;
  const values = prepared.orderBy.map(({ variable }) => last[variable] ?? null);
  const nextCursor = encodeEnvelope({
    version: 1,
    queryFingerprint: prepared.queryFingerprint,
    scopeFingerprint: prepared.scopeFingerprint,
    basis: prepared.basis,
    values,
  });

  return {
    ...result,
    results,
    nextCursor,
    ...(result.debug === undefined
      ? {}
      : { debug: { ...result.debug, resultCount: results.length } }),
  };
};
