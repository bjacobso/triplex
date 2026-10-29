import { Effect } from "effect";

import { TransactionId, type EntityId } from "../Branded.js";
import type { DatalogQuery } from "../datalog/types.js";
import { ReadError } from "../errors/index.js";
import { ref } from "../Value.js";
import { TxAttributes } from "../utils/id.js";
import type {
  EntityTransactionPage,
  EntityTransactionPageRequest,
  QueryResponse,
  TransactionRecord,
} from "./Triples.js";

interface EntityTransactionReader {
  readonly currentPosition: () => Effect.Effect<number, ReadError>;
  readonly query: (query: DatalogQuery) => Effect.Effect<QueryResponse, unknown>;
  readonly transaction: (
    transactionId: TransactionId,
  ) => Effect.Effect<TransactionRecord | null, ReadError>;
  /**
   * Transactions that changed the entity without indexing it in the journal
   * (segment attachments), at or before `snapshotPosition`.
   */
  readonly segmentTransactions?: (
    snapshotPosition: number,
  ) => Effect.Effect<
    readonly { readonly transactionId: TransactionId; readonly position: number }[]
  >;
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
    const where: DatalogQuery["where"] = [
      ["?transaction", TxAttributes.CHANGED_ENTITY, ref(entityId)],
      ["?transaction", TxAttributes.POSITION, "?position"],
      ["<=", "?position", snapshotPosition],
      ...(request.beforePosition === undefined
        ? []
        : ([["<", "?position", request.beforePosition]] as const)),
    ];
    const response = yield* reader
      .query({
        find: ["?transaction", "?position"],
        where,
        orderBy: [{ variable: "?position", direction: "desc" }],
        limit: limit + 1,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ReadError({
              message: `Failed to query entity transaction index: ${String(cause)}`,
              cause,
            }),
        ),
      );

    const indexed = yield* Effect.forEach(response.results, (row) =>
      Effect.try({
        try: () => {
          const transaction = row["?transaction"];
          const position = row["?position"];
          if (
            typeof transaction !== "string" ||
            typeof position !== "number" ||
            !Number.isSafeInteger(position) ||
            position < 1
          ) {
            throw new TypeError("invalid transaction journal index row");
          }
          return { transactionId: TransactionId.make(transaction), position };
        },
        catch: (cause) =>
          new ReadError({ message: "Corrupt entity transaction journal index", cause }),
      }),
    );
    const attached = reader.segmentTransactions
      ? (yield* reader.segmentTransactions(snapshotPosition)).filter(
          ({ position }) =>
            request.beforePosition === undefined || position < request.beforePosition,
        )
      : [];
    const merged =
      attached.length === 0
        ? indexed
        : [...indexed, ...attached].sort((left, right) => right.position - left.position);
    const selected = merged.slice(0, limit);
    const records = yield* Effect.forEach(selected, ({ transactionId, position }) =>
      reader.transaction(transactionId).pipe(
        Effect.flatMap((record) =>
          record !== null && record.position === position
            ? Effect.succeed(record)
            : Effect.fail(
                new ReadError({
                  message: `Missing or inconsistent transaction envelope ${transactionId}`,
                }),
              ),
        ),
      ),
    );
    const last = records.at(-1);
    return {
      transactions: records,
      snapshotPosition,
      ...(merged.length > limit && last !== undefined ? { nextBeforePosition: last.position } : {}),
    };
  });
};
