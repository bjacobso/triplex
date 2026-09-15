/**
 * EntitySnapshots capability — materializes JSON snapshots + content hashes
 * on every write operation.
 *
 * Write operations trigger post-commit snapshot materialization for all touched
 * entities. Snapshot reads remain explicit through `SnapshotService`.
 *
 * Priority: 60 (outside change emission at 50). Requires no other capability.
 */

import { Effect, Option, pipe } from "effect";
import type { StoreCapability } from "../store/StoreCapability.js";
import type { TriplesService } from "../store/Triples.js";
import type { SnapshotWriterShape } from "./SnapshotService.js";
import type { Triple, EntityId } from "../Triple.js";
import { generateTransactionId, SystemPrefixes, TxAttributes } from "../utils/id.js";
import { WriteError } from "../errors/index.js";
import { unsafe } from "../Branded.js";

const resolveTxTime = (
  store: TriplesService,
  txId: string,
  assertedTriples: readonly Triple[],
): Effect.Effect<number, WriteError> =>
  Effect.gen(function* () {
    if (assertedTriples.length > 0) {
      return assertedTriples[0]!.recordedAt;
    }

    const txMetaTriples = yield* store
      .match({ entityId: unsafe.entityId(txId), attribute: TxAttributes.INSTANT })
      .pipe(Effect.catch(() => Effect.succeed([] as readonly Triple[])));
    const txInstant = txMetaTriples.find((triple) => triple.value.type === "datetime");
    if (txInstant && txInstant.value.type === "datetime") {
      return txInstant.value.value;
    }

    return yield* Effect.fail(
      new WriteError({
        message: `Unable to resolve tx time for ${txId}`,
      }),
    );
  });

const resolveRetractionMeta = (
  store: TriplesService,
  entityId: EntityId,
  tripleId: Triple["id"],
): Effect.Effect<{ txId: string; txTime: number } | null> =>
  Effect.gen(function* () {
    const history = yield* store
      .history(entityId)
      .pipe(Effect.catch(() => Effect.succeed([] as readonly Triple[])));
    const retracted = history.find(
      (triple) =>
        triple.id === tripleId &&
        Option.isSome(triple.retractedAt) &&
        Option.isSome(triple.retractTxId),
    );

    if (
      !retracted ||
      Option.isNone(retracted.retractedAt) ||
      Option.isNone(retracted.retractTxId)
    ) {
      return null;
    }

    return {
      txId: retracted.retractTxId.value,
      txTime: retracted.retractedAt.value,
    };
  });

/**
 * Map snapshot errors to WriteError.
 *
 * Snapshot projection errors are propagated so callers know the derived state is stale.
 * The source fact transaction has already committed and is not rolled back.
 */
const mapMaterializeError = (cause: unknown): WriteError =>
  new WriteError({
    message: "Failed to materialize entity snapshot",
    cause,
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect unique entity IDs from a set of triples.
 */
const uniqueEntityIds = (triples: readonly Triple[]): string[] => [
  ...new Set(triples.map((t) => t.entityId)),
];

// ---------------------------------------------------------------------------
// Capability Factory
// ---------------------------------------------------------------------------

/**
 * Create an EntitySnapshots capability.
 *
 * @param writer - Snapshot writer for materializing snapshots on writes
 */
export const makeEntitySnapshotsCapability = (writer: SnapshotWriterShape): StoreCapability => ({
  name: "EntitySnapshots",
  priority: 60,
  requires: [],
  wrap: (store: TriplesService): TriplesService => ({
    ...store,
    // -----------------------------------------------------------------------
    // Write operations — materialize snapshots after each write
    // -----------------------------------------------------------------------

    assert: (input) =>
      pipe(
        store.assert(input),
        Effect.tap((triple) =>
          writer
            .materialize(
              Option.getOrElse(triple.txId, () => generateTransactionId()),
              triple.recordedAt,
              [triple.entityId],
            )
            .pipe(Effect.mapError(mapMaterializeError)),
        ),
      ),

    assertBatch: (inputs) =>
      pipe(
        store.assertBatch(inputs),
        Effect.tap((triples) => {
          if (triples.length === 0) return Effect.void;
          const entityIds = uniqueEntityIds(triples);
          const first = triples[0]!;
          return writer
            .materialize(
              Option.getOrElse(first.txId, () => generateTransactionId()),
              first.recordedAt,
              entityIds,
            )
            .pipe(Effect.mapError(mapMaterializeError));
        }),
      ),

    retract: (id) =>
      Effect.gen(function* () {
        const triple = yield* store.get(id).pipe(Effect.catch(() => Effect.succeed(null)));
        if (!triple) {
          yield* store.retract(id);
          return;
        }

        yield* store.retract(id);
        const meta = yield* resolveRetractionMeta(store, triple.entityId as EntityId, triple.id);
        if (!meta) {
          return yield* Effect.fail(
            new WriteError({
              message: `Unable to resolve retract tx metadata for triple ${String(id)}`,
            }),
          );
        }
        yield* writer
          .materialize(meta.txId, meta.txTime, [triple.entityId])
          .pipe(Effect.mapError(mapMaterializeError));
      }).pipe(
        Effect.mapError((error) =>
          error && typeof error === "object" && "_tag" in error && error._tag === "WriteError"
            ? (error as WriteError)
            : new WriteError({ message: "Failed to retract triple", cause: error }),
        ),
      ),

    retractByPattern: (pattern) =>
      Effect.gen(function* () {
        const matchingTriples = yield* store
          .match(pattern)
          .pipe(Effect.catch(() => Effect.succeed([] as readonly Triple[])));
        const count = yield* store.retractByPattern(pattern);
        if (matchingTriples.length > 0) {
          const anchor = matchingTriples[0]!;
          const meta = yield* resolveRetractionMeta(store, anchor.entityId as EntityId, anchor.id);
          if (!meta) {
            return yield* Effect.fail(
              new WriteError({
                message: `Unable to resolve retract tx metadata for pattern retraction`,
              }),
            );
          }
          const entityIds = uniqueEntityIds(matchingTriples);
          yield* writer
            .materialize(meta.txId, meta.txTime, entityIds)
            .pipe(Effect.mapError(mapMaterializeError));
        }
        return count;
      }),

    transact: (operations, meta) =>
      Effect.gen(function* () {
        // Pre-fetch triples for retract-by-ID ops to resolve entityIds
        const retractEntityMap = new Map<string, string>();
        for (const op of operations) {
          if (op.op === "retract") {
            const triple = yield* store
              .get(op.id as any)
              .pipe(Effect.catch(() => Effect.succeed(null)));
            if (triple) {
              retractEntityMap.set(op.id, triple.entityId);
            }
          }
        }

        const result = yield* store.transact(operations, meta);
        const record = yield* store
          .transaction(result.txId)
          .pipe(Effect.mapError(mapMaterializeError));

        // Collect all entity IDs touched by the transaction
        const entityIds = new Set<string>();

        for (const triple of result.triples) {
          entityIds.add(triple.entityId);
        }

        for (const op of operations) {
          if (op.op === "assert") {
            entityIds.add(op.entityId);
          } else if (op.op === "retract") {
            const eid = retractEntityMap.get(op.id);
            if (eid) entityIds.add(eid);
          } else if (op.op === "retract-pattern" && typeof op.pattern.entityId === "string") {
            entityIds.add(op.pattern.entityId);
          }
        }

        // The journal includes the exact retract-pattern matches from the atomic
        // write, including patterns that did not name an entity explicitly.
        if (record) {
          entityIds.clear();
          for (const change of record.changes) entityIds.add(change.entityId);
        }

        // Filter out _Transaction metadata entities
        const filteredIds = [...entityIds].filter(
          (id) => !id.startsWith(`${SystemPrefixes.TRANSACTION}/`),
        );

        if (filteredIds.length > 0) {
          const txTime =
            record?.instant ?? (yield* resolveTxTime(store, result.txId, result.triples));
          yield* writer
            .materialize(result.txId, txTime, filteredIds)
            .pipe(Effect.mapError(mapMaterializeError));
        }

        return result;
      }),
  }),
});
