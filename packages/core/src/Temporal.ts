import { Schema } from "effect";

/**
 * The two independent axes used to read bitemporal facts.
 *
 * `recordedAt` asks what the database knew at an instant. When omitted, reads
 * use the latest recorded state. `validAt` asks what was true in business
 * time. Public read APIs resolve an omitted value to their clock's current
 * instant before reaching a backend.
 *
 * `recordedPosition` cuts recorded time by commit position instead of by
 * instant: the read sees exactly the transactions committed at or before that
 * position (`TransactionResult.position`), which is exact even when several
 * transactions share a millisecond. With both `recordedAt` and
 * `recordedPosition`, a fact must be visible under both. A position after the
 * latest commit reads the latest state, so it is only stable once committed;
 * `PositionRef` publishes committed positions under a name.
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
  /** Exact commit cut: transactions at or before this position. */
  readonly recordedPosition?: number;
  readonly validAt: number;
}

export const validateTemporalInstant = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite epoch-millisecond instant`);
  }
};

export const validateCommitPosition = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer commit position`);
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
  if (basis?.validAt !== undefined) {
    validateTemporalInstant("validAt", basis.validAt);
  }
  if (basis?.recordedPosition !== undefined) {
    validateCommitPosition("recordedPosition", basis.recordedPosition);
  }
  return {
    ...(basis?.recordedAt !== undefined ? { recordedAt: basis.recordedAt } : {}),
    ...(basis?.recordedPosition !== undefined ? { recordedPosition: basis.recordedPosition } : {}),
    validAt: basis?.validAt ?? now,
  };
};
