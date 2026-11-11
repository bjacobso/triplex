import { Effect } from "effect";
import { ReadError } from "../errors/index.js";

/** Capture once, validate, then resolve through the backend's journal index. */
export const resolveRecordedBasis = (
  currentPosition: () => Effect.Effect<number, ReadError>,
  positionAt: (instant: number, head: number) => Effect.Effect<number, ReadError>,
  now: Effect.Effect<number>,
  basis?: { readonly recordedAt?: number; readonly recordedPosition?: number },
): Effect.Effect<{ readonly recordedPosition: number }, ReadError> =>
  Effect.gen(function* () {
    const head = yield* currentPosition();
    if (basis?.recordedAt !== undefined && basis.recordedPosition !== undefined)
      return yield* new ReadError({ message: "Specify recordedAt or recordedPosition, not both" });
    if (basis?.recordedAt !== undefined && !Number.isFinite(basis.recordedAt))
      return yield* new ReadError({ message: "recordedAt must be finite" });
    if (
      basis?.recordedPosition !== undefined &&
      (!Number.isSafeInteger(basis.recordedPosition) ||
        basis.recordedPosition < 0 ||
        basis.recordedPosition > head)
    )
      return yield* new ReadError({
        message: "recordedPosition must be a non-negative integer at or below the committed head",
      });
    return {
      recordedPosition:
        basis?.recordedPosition ??
        (basis?.recordedAt === undefined || basis.recordedAt >= (yield* now)
          ? head
          : yield* positionAt(basis.recordedAt, head)),
    };
  });
