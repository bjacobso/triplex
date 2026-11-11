import { Effect } from "effect";
import { DatalogValidationError } from "../errors/index.js";
import {
  resolveTemporalBasis,
  validateTemporalInstant,
  type TemporalBasis,
  type ResolvedTemporalBasis,
} from "../Temporal.js";
import type { DatalogQuery } from "./schema.js";

/** Datalog can select all valid intervals while retaining one recorded cut. */
export interface QueryTemporalBasis extends Omit<ResolvedTemporalBasis, "validAt"> {
  readonly validAt?: number | undefined;
}

export const assertQueryBasis = (query: DatalogQuery, basis?: TemporalBasis): void => {
  if (query.validTime === "all" && basis?.validAt !== undefined) {
    throw new DatalogValidationError({
      message: "validTime all cannot be combined with explicit validAt",
      code: "datalog.invalid-temporal-basis",
      path: "basis.validAt",
      fix: "Remove validAt or use validTime point.",
      query,
    });
  }
};

export const resolveQueryBasis = (
  query: DatalogQuery,
  basis: TemporalBasis | undefined,
  now: number,
): QueryTemporalBasis => {
  assertQueryBasis(query, basis);
  if (query.validTime !== "all") return resolveTemporalBasis(basis, now);
  if (basis?.recordedAt !== undefined) validateTemporalInstant("recordedAt", basis.recordedAt);
  if (
    basis?.recordedPosition !== undefined &&
    (!Number.isSafeInteger(basis.recordedPosition) ||
      basis.recordedPosition < 0 ||
      basis.recordedAt !== undefined)
  ) {
    throw new DatalogValidationError({
      message: "Supply one recorded cut: a timestamp or a non-negative safe commit position",
      query,
    });
  }
  return {
    ...(basis?.recordedAt === undefined ? {} : { recordedAt: basis.recordedAt }),
    ...(basis?.recordedPosition === undefined ? {} : { recordedPosition: basis.recordedPosition }),
  };
};

/** A validator view fixes recorded time; only its explicit valid option selects a point. */
export const queryBasisForView = (
  query: DatalogQuery,
  resolved: ResolvedTemporalBasis,
  options?: { readonly validAt?: number },
): Effect.Effect<QueryTemporalBasis, DatalogValidationError> =>
  Effect.try({
    try: () =>
      resolveQueryBasis(
        query,
        {
          recordedPosition: resolved.recordedPosition!,
          ...(options?.validAt === undefined ? {} : { validAt: options.validAt }),
        },
        resolved.validAt,
      ),
    catch: (cause) =>
      cause instanceof DatalogValidationError
        ? cause
        : new DatalogValidationError({ message: String(cause), query }),
  });
