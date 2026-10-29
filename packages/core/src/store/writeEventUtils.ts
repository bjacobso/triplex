/**
 * writeEventUtils — shared helpers for building ChangeEvents from write operations.
 *
 * ChangeEmissionCapability uses these helpers to intercept writes, build
 * ChangeEvent objects, and invoke its emitter.
 */

import { Effect, Option, pipe } from "effect";
import type { TriplesService } from "./Triples.js";
import type { ChangeEvent, TripleChange } from "./ChangeEmitter.js";

// =============================================================================
// Write Interceptor
// =============================================================================

/**
 * Callback invoked after each successful write operation.
 * Receives the ChangeEvent describing what changed.
 * The callback's return value is awaited but errors should be handled
 * by the caller (typically caught and swallowed).
 */
export type WriteEventCallback = (event: ChangeEvent) => Effect.Effect<void>;

/**
 * Create write-side methods for a TriplesService that intercept every
 * mutation, delegate to the inner store, build a ChangeEvent, and invoke
 * the callback. Read operations are NOT included — callers should spread
 * the inner store's read methods directly.
 *
 * Pre-fetches triple info for retract-by-ID operations so the ChangeEvent
 * includes correct entityId/attribute even after the triple is removed.
 */
export const makeWriteInterceptors = (
  inner: TriplesService,
  onEvent: WriteEventCallback,
  now: Effect.Effect<number>,
): Pick<
  TriplesService,
  "assert" | "assertBatch" | "retract" | "retractByPattern" | "transact"
> => ({
  assert: (input) =>
    pipe(
      inner.assert(input),
      Effect.tap((triple) =>
        onEvent({
          txId: Option.getOrElse(triple.txId, () => ""),
          timestamp: triple.recordedAt,
          changes: [
            { operation: "assert" as const, entityId: input.entityId, attribute: input.attribute },
          ],
        }),
      ),
    ),

  assertBatch: (inputs) =>
    pipe(
      inner.assertBatch(inputs),
      Effect.tap((triples) => {
        return Effect.gen(function* () {
          const changes: TripleChange[] = inputs.map((input) => ({
            operation: "assert" as const,
            entityId: input.entityId,
            attribute: input.attribute,
          }));
          const first = triples[0];
          return yield* onEvent({
            txId: first ? Option.getOrElse(first.txId, () => "") : "",
            timestamp: first?.recordedAt ?? (yield* now),
            changes,
          });
        });
      }),
    ),

  retract: (id) =>
    pipe(
      inner.get(id),
      Effect.catch(() => Effect.succeed(null)),
      Effect.flatMap((triple) =>
        pipe(
          inner.retract(id),
          Effect.tap(() =>
            Effect.gen(function* () {
              return yield* onEvent({
                txId: "",
                timestamp: yield* now,
                changes: triple
                  ? [
                      {
                        operation: "retract" as const,
                        entityId: triple.entityId,
                        attribute: triple.attribute,
                      },
                    ]
                  : [],
              });
            }),
          ),
        ),
      ),
    ),

  retractByPattern: (pattern) =>
    Effect.gen(function* () {
      const matched = yield* inner.match(pattern);
      const count = yield* inner.retractByPattern(pattern);
      if (count > 0) {
        yield* onEvent({
          txId: "",
          timestamp: yield* now,
          changes: matched.map((triple) => ({
            operation: "retract" as const,
            entityId: triple.entityId,
            attribute: triple.attribute,
          })),
        });
      }
      return count;
    }),

  transact: (operations, meta) =>
    Effect.gen(function* () {
      // Pre-fetch triples for low-level fallbacks. The committed transaction
      // envelope below is authoritative and includes exact retract-pattern
      // matches from inside the atomic boundary.
      const tripleMap = new Map<string, { entityId: string; attribute: string }>();
      for (const op of operations) {
        if (op.op === "retract") {
          const triple = yield* inner
            .get(op.id as any)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (triple) {
            tripleMap.set(op.id, { entityId: triple.entityId, attribute: triple.attribute });
          }
        }
      }

      const result = yield* inner.transact(operations, meta);

      const record = yield* inner.transaction(result.txId);
      // A summary-journaled record has no change list; fall back to the operations.
      const changes: TripleChange[] =
        record && record.summary === undefined
          ? record.changes.map((change) => ({
              operation: change.op,
              entityId: change.entityId,
              attribute: change.attribute,
            }))
          : operations.flatMap((op): TripleChange[] => {
              if (op.op === "assert") {
                return [{ operation: "assert", entityId: op.entityId, attribute: op.attribute }];
              }
              if (op.op === "retract") {
                const info = tripleMap.get(op.id);
                return info ? [{ operation: "retract", ...info }] : [];
              }
              return [];
            });

      const event: ChangeEvent = { txId: result.txId, timestamp: yield* now, changes };
      yield* onEvent(event);

      return result;
    }),
});
