import { Schema } from "effect";

/**
 * The two independent axes used to read bitemporal facts.
 *
 * `recordedAt` asks what the database knew at an instant; `recordedPosition`
 * selects an exact commit cut (zero is the empty cut). Supply at most one.
 * When both are omitted, reads use the latest recorded state.
 * `validAt` asks what was true in business
 * time. Public read APIs resolve an omitted value to their clock's current
 * instant before reaching a backend.
 */
export const TemporalBasis = Schema.Struct({
  recordedAt: Schema.optional(Schema.Number),
  recordedPosition: Schema.optional(Schema.Number),
  validAt: Schema.optional(Schema.Number),
});
export type TemporalBasis = typeof TemporalBasis.Type;

/** A basis whose business-time instant has been resolved by the caller. */
export interface ResolvedTemporalBasis {
  readonly recordedAt?: number;
  /** Exact commit cut; internal pagination may additionally pin a timestamp. */
  readonly recordedPosition?: number;
  readonly validAt: number;
}

export const validateTemporalInstant = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite epoch-millisecond instant`);
  }
};

export const resolveTemporalBasis = (
  basis: TemporalBasis | undefined,
  now: number,
): ResolvedTemporalBasis => {
  validateTemporalInstant("current time", now);
  if (basis?.recordedAt !== undefined) {
    validateTemporalInstant("recordedAt", basis.recordedAt);
  }
  if (basis?.recordedPosition !== undefined) {
    if (!Number.isSafeInteger(basis.recordedPosition) || basis.recordedPosition < 0) {
      throw new Error("recordedPosition must be a non-negative safe integer");
    }
    if (basis.recordedAt !== undefined) {
      throw new Error("recordedAt and recordedPosition cannot both be supplied");
    }
  }
  if (basis?.validAt !== undefined) {
    validateTemporalInstant("validAt", basis.validAt);
  }
  return {
    ...(basis?.recordedAt !== undefined ? { recordedAt: basis.recordedAt } : {}),
    ...(basis?.recordedPosition !== undefined ? { recordedPosition: basis.recordedPosition } : {}),
    validAt: basis?.validAt ?? now,
  };
};
