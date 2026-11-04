/**
 * Internal commit-validator execution shared by every `Triples`
 * implementation. Not part of the public API.
 */

import { Effect } from "effect";

import type { TransactionId } from "../Branded.js";
import * as CanonicalJson from "../content/CanonicalJson.js";
import { CommitRejectedError, ReadError, WriteError } from "../errors/index.js";
import type { ResolvedTemporalBasis } from "../Temporal.js";
import type {
  Attempt,
  CommitContext,
  CommitRejection,
  Rejection,
  Validator,
  ViewOptions,
} from "./CommitValidation.js";
import type { TransactionMeta } from "./Triples.js";

const MAX_NAME_LENGTH = 256;

const invalidRejection = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "not an object";
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["code"] !== "string" || candidate["code"].length === 0) {
    return "code must be a non-empty string";
  }
  if (typeof candidate["message"] !== "string") return "message must be a string";
  for (const field of ["entityId", "attribute", "suggestion"] as const) {
    if (candidate[field] !== undefined && typeof candidate[field] !== "string") {
      return `${field} must be a string`;
    }
  }
  const path = candidate["path"];
  if (
    path !== undefined &&
    (!Array.isArray(path) ||
      path.some((part) => typeof part !== "string" && typeof part !== "number"))
  ) {
    return "path must be an array of strings and numbers";
  }
  const details = candidate["details"];
  if (details !== undefined) {
    if (typeof details !== "object" || details === null || Array.isArray(details)) {
      return "details must be a JSON object";
    }
    try {
      CanonicalJson.encodeOrThrow(details as CanonicalJson.CanonicalValue);
    } catch (error) {
      return `details must be JSON-serializable: ${String((error as Error).message ?? error)}`;
    }
  }
  return undefined;
};

/** Copy only contract fields, detaching evidence from later mutation. */
const normalizeRejection = (rejection: Rejection, validator: string): CommitRejection => ({
  validator,
  code: rejection.code,
  message: rejection.message,
  ...(rejection.entityId === undefined ? {} : { entityId: rejection.entityId }),
  ...(rejection.attribute === undefined ? {} : { attribute: rejection.attribute }),
  ...(rejection.path === undefined ? {} : { path: [...rejection.path] }),
  ...(rejection.details === undefined
    ? {}
    : {
        details: JSON.parse(
          CanonicalJson.encodeOrThrow(rejection.details as CanonicalJson.CanonicalValue),
        ) as { readonly [key: string]: unknown },
      }),
  ...(rejection.suggestion === undefined ? {} : { suggestion: rejection.suggestion }),
});

export const attemptFrom = (
  txId: TransactionId,
  instant: number,
  position: number,
  meta: TransactionMeta | undefined,
): Attempt => ({
  txId,
  instant,
  basisPosition: position - 1,
  ...(meta?.actor === undefined ? {} : { actor: meta.actor }),
  ...(meta?.commandId === undefined ? {} : { commandId: meta.commandId }),
  ...(meta?.correlationId === undefined ? {} : { correlationId: meta.correlationId }),
  ...(meta?.causationId === undefined ? {} : { causationId: meta.causationId }),
  ...(meta?.configSnapshot === undefined ? {} : { configSnapshot: meta.configSnapshot }),
});

/**
 * Resolve a view read to an exact commit cut. The recorded axis is fixed by
 * the view; only business time is selectable.
 */
export const viewBasis = (
  position: number,
  instant: number,
  options: ViewOptions | undefined,
): Effect.Effect<ResolvedTemporalBasis, ReadError> => {
  const validAt = options?.validAt ?? instant;
  return Number.isFinite(validAt) && validAt >= 0
    ? Effect.succeed({ recordedPosition: position, validAt })
    : Effect.fail(
        new ReadError({
          message: "validAt must be a non-negative finite epoch-millisecond instant",
        }),
      );
};

const rejectionMessage = (rejections: readonly CommitRejection[]): string => {
  const first = rejections[0]!;
  const more = rejections.length > 1 ? ` (and ${rejections.length - 1} more)` : "";
  return `Transaction rejected by commit validator ${first.validator}: [${first.code}] ${first.message}${more}`;
};

/**
 * Run validators sequentially in declaration order. Every validator runs, so
 * the rejection carries complete evidence; the first validator failure stops
 * the run and aborts the transaction.
 */
export const runValidators = (
  validators: readonly Validator[],
  context: CommitContext,
): Effect.Effect<void, CommitRejectedError | WriteError> =>
  Effect.gen(function* () {
    const ran: string[] = [];
    const rejections: CommitRejection[] = [];
    for (const validator of validators) {
      if (
        typeof validator.name !== "string" ||
        validator.name.length === 0 ||
        validator.name.length > MAX_NAME_LENGTH
      ) {
        return yield* Effect.fail(
          new WriteError({
            message: `Commit validator names must contain between 1 and ${MAX_NAME_LENGTH} characters`,
          }),
        );
      }
      if (ran.includes(validator.name)) {
        return yield* Effect.fail(
          new WriteError({ message: `Duplicate commit validator name ${validator.name}` }),
        );
      }
      ran.push(validator.name);
      const returned: unknown = yield* validator.validate(context).pipe(
        Effect.mapError(
          (cause) =>
            new WriteError({
              message: `Commit validator ${validator.name} failed: ${cause.message}`,
              cause,
            }),
        ),
      );
      if (returned === undefined) continue;
      if (!Array.isArray(returned)) {
        return yield* Effect.fail(
          new WriteError({
            message: `Commit validator ${validator.name} must return an array of rejections or nothing`,
          }),
        );
      }
      for (const rejection of returned) {
        const invalid = invalidRejection(rejection);
        if (invalid !== undefined) {
          return yield* Effect.fail(
            new WriteError({
              message: `Commit validator ${validator.name} returned an invalid rejection: ${invalid}`,
            }),
          );
        }
        rejections.push(normalizeRejection(rejection as Rejection, validator.name));
      }
    }
    if (rejections.length > 0) {
      return yield* Effect.fail(
        new CommitRejectedError({
          message: rejectionMessage(rejections),
          validators: ran,
          rejections,
          attempt: context.transaction,
          changes: context.changes,
        }),
      );
    }
  });
