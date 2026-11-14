import { Effect } from "effect";

import type { EntityId } from "../Branded.js";
import { ReadError } from "../errors/index.js";
import type { JournalEntry } from "./journal.js";
import type {
  EntityTransactionPage,
  EntityTransactionPageRequest,
  TransactionRecord,
} from "./Triples.js";

interface EntityTransactionReader {
  readonly currentPosition: () => Effect.Effect<number, ReadError>;
  /** Indexed entries that changed the entity, newest first. */
  readonly entries: (
    entityId: string,
    snapshotPosition: number,
    beforePosition: number | undefined,
    limit: number,
  ) => Effect.Effect<readonly JournalEntry[], ReadError>;
  readonly hydrate: (
    entries: readonly JournalEntry[],
  ) => Effect.Effect<readonly TransactionRecord[], ReadError>;
}

const invalidPage = (message: string) => Effect.fail(new ReadError({ message }));

/** Indexed journal lookup shared by the KV and SQL `Triples` implementations. */
export const transactionsForEntity = (
  reader: EntityTransactionReader,
  entityId: EntityId,
  request: EntityTransactionPageRequest = {},
): Effect.Effect<EntityTransactionPage, ReadError> => {
  const limit = request.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    return invalidPage("Entity transaction page limit must be between 1 and 1000");
  }
  if (
    request.snapshotPosition !== undefined &&
    (!Number.isSafeInteger(request.snapshotPosition) || request.snapshotPosition < 0)
  ) {
    return invalidPage("Entity transaction snapshot position must be a non-negative integer");
  }
  if (
    request.beforePosition !== undefined &&
    (!Number.isSafeInteger(request.beforePosition) || request.beforePosition < 0)
  ) {
    return invalidPage("Entity transaction page boundary must be a non-negative integer");
  }

  return Effect.gen(function* () {
    const snapshotPosition = request.snapshotPosition ?? (yield* reader.currentPosition());
    const indexed = yield* reader.entries(
      entityId,
      snapshotPosition,
      request.beforePosition,
      limit + 1,
    );
    const records = yield* reader.hydrate(indexed.slice(0, limit));
    const last = records.at(-1);
    return {
      transactions: records,
      snapshotPosition,
      ...(indexed.length > limit && last !== undefined
        ? { nextBeforePosition: last.position }
        : {}),
    };
  });
};
