/**
 * Durable resume positions for at-least-once transaction-feed consumers.
 *
 * A checkpoint is an ordinary reserved Triplex entity. Its position is moved
 * with compare-and-retract, so two workers cannot silently overwrite one
 * another. The feed remains the source of truth; this module only records how
 * far one named consumer has durably processed it.
 */

import { Data, Effect } from "effect";

import * as ContentIds from "../content/ContentId.js";
import type {
  CommandAlreadyCommittedError,
  ConstraintViolationError,
  OperationalEntryConflictError,
  ReadError,
  TransactionConflictError,
  WriteError,
} from "../errors/index.js";
import type { TransactionMeta, TriplesService } from "../store/Triples.js";
import { transactSystemUnjournaled } from "../store/systemNamespace.js";
import type { TransactOp } from "../Triple.js";
import { unsafe, type EntityId, type TripleId } from "../Branded.js";

export const System = {
  prefix: "_triplex/consumer-checkpoint/",
  entityType: "triplex.consumer-checkpoint",
  attribute: {
    consumer: ":triplex/consumer-checkpoint-name",
    position: ":triplex/consumer-checkpoint-position",
  },
} as const;

export interface ConsumerCheckpoint {
  readonly consumer: string;
  readonly position: number;
}

export interface AdvanceRequest {
  readonly consumer: string;
  /** Position read before processing the page. Use zero for a new consumer. */
  readonly expectedPosition: number;
  /** Last transaction position whose effects have durably completed. */
  readonly nextPosition: number;
  readonly meta?: Omit<TransactionMeta, "commandId" | "preconditions">;
}

export class InvalidConsumerCheckpointError extends Data.TaggedError(
  "InvalidConsumerCheckpointError",
)<{
  readonly message: string;
}> {}

export class ConsumerCheckpointConflictError extends Data.TaggedError(
  "ConsumerCheckpointConflictError",
)<{
  readonly consumer: string;
  readonly expectedPosition: number;
  readonly actualPosition?: number;
  readonly message: string;
}> {}

export class CorruptConsumerCheckpointError extends Data.TaggedError(
  "CorruptConsumerCheckpointError",
)<{
  readonly consumer: string;
  readonly message: string;
}> {}

export type ConsumerCheckpointError =
  | OperationalEntryConflictError
  | InvalidConsumerCheckpointError
  | ConsumerCheckpointConflictError
  | CorruptConsumerCheckpointError
  | ReadError
  | WriteError
  | TransactionConflictError
  | CommandAlreadyCommittedError
  | ConstraintViolationError;

interface LoadedCheckpoint extends ConsumerCheckpoint {
  readonly positionTripleId: TripleId;
}

const validateConsumer = (consumer: string): InvalidConsumerCheckpointError | undefined => {
  if (consumer.length === 0 || consumer.length > 1_024) {
    return new InvalidConsumerCheckpointError({
      message: "Consumer checkpoint name must contain between 1 and 1024 characters",
    });
  }
  return undefined;
};

const validatePosition = (
  label: string,
  position: number,
): InvalidConsumerCheckpointError | undefined =>
  Number.isSafeInteger(position) && position >= 0
    ? undefined
    : new InvalidConsumerCheckpointError({
        message: `${label} must be a non-negative safe integer`,
      });

export const entityId = (consumer: string): EntityId =>
  unsafe.entityId(
    `${System.prefix}${ContentIds.hash(ContentIds.Domain.consumerCheckpoint, consumer)}`,
  );

const readLoaded = (
  triples: TriplesService,
  consumer: string,
): Effect.Effect<LoadedCheckpoint | null, ReadError | CorruptConsumerCheckpointError> =>
  triples.liveFacts(entityId(consumer)).pipe(
    Effect.flatMap((rows) => {
      if (rows.length === 0) return Effect.succeed(null);

      const names = rows.filter((row) => row.attribute === System.attribute.consumer);
      const positions = rows.filter((row) => row.attribute === System.attribute.position);
      const name = names[0]?.value;
      const position = positions[0]?.value;
      if (
        names.length !== 1 ||
        positions.length !== 1 ||
        name?.type !== "string" ||
        name.value !== consumer ||
        position?.type !== "number" ||
        !Number.isSafeInteger(position.value) ||
        position.value < 0
      ) {
        return Effect.fail(
          new CorruptConsumerCheckpointError({
            consumer,
            message: `Consumer checkpoint ${consumer} has an invalid persisted shape`,
          }),
        );
      }

      return Effect.succeed({
        consumer,
        position: position.value,
        positionTripleId: positions[0]!.id,
      });
    }),
  );

/** Read the current durable position for a named consumer. */
export const get = (
  triples: TriplesService,
  consumer: string,
): Effect.Effect<
  ConsumerCheckpoint | null,
  InvalidConsumerCheckpointError | ReadError | CorruptConsumerCheckpointError
> => {
  const invalid = validateConsumer(consumer);
  if (invalid !== undefined) return Effect.fail(invalid);
  return readLoaded(triples, consumer);
};

const conflict = (
  consumer: string,
  expectedPosition: number,
  actualPosition: number | undefined,
): ConsumerCheckpointConflictError =>
  new ConsumerCheckpointConflictError({
    consumer,
    expectedPosition,
    ...(actualPosition === undefined ? {} : { actualPosition }),
    message: `Consumer ${consumer} expected checkpoint ${expectedPosition}, but found ${actualPosition ?? "no checkpoint"}`,
  });

const assertPosition = (consumer: string, position: number): TransactOp => ({
  op: "assert",
  entityId: entityId(consumer),
  entityType: System.entityType,
  attribute: System.attribute.position,
  value: { type: "number", value: position },
  validFrom: 0,
});

/**
 * Advance one consumer checkpoint with optimistic concurrency.
 *
 * Repeating an already-successful `(expectedPosition, nextPosition)` movement
 * returns the stored checkpoint. A stale or out-of-order movement fails with a
 * typed conflict and never moves the position backwards.
 */
export const advance = (
  triples: TriplesService,
  request: AdvanceRequest,
): Effect.Effect<ConsumerCheckpoint, ConsumerCheckpointError> =>
  Effect.gen(function* () {
    const invalidConsumer = validateConsumer(request.consumer);
    if (invalidConsumer !== undefined) return yield* Effect.fail(invalidConsumer);
    const invalidExpected = validatePosition("expectedPosition", request.expectedPosition);
    if (invalidExpected !== undefined) return yield* Effect.fail(invalidExpected);
    const invalidNext = validatePosition("nextPosition", request.nextPosition);
    if (invalidNext !== undefined) return yield* Effect.fail(invalidNext);
    if (request.nextPosition < request.expectedPosition) {
      return yield* Effect.fail(
        new InvalidConsumerCheckpointError({
          message: "nextPosition must not be less than expectedPosition",
        }),
      );
    }
    const latestPosition = yield* triples.currentPosition();
    if (request.nextPosition > latestPosition) {
      return yield* Effect.fail(
        new InvalidConsumerCheckpointError({
          message: `nextPosition ${request.nextPosition} is ahead of the latest committed position ${latestPosition}`,
        }),
      );
    }

    const current = yield* readLoaded(triples, request.consumer);
    if (current?.position === request.nextPosition) return current;
    if ((current?.position ?? 0) !== request.expectedPosition) {
      return yield* Effect.fail(
        conflict(request.consumer, request.expectedPosition, current?.position),
      );
    }

    if (current === null) {
      const id = entityId(request.consumer);
      yield* transactSystemUnjournaled(
        triples,
        [
          {
            op: "assert",
            entityId: id,
            entityType: System.entityType,
            attribute: System.attribute.consumer,
            value: { type: "string", value: request.consumer },
            validFrom: 0,
          },
          assertPosition(request.consumer, request.nextPosition),
        ],
        {
          ...request.meta,
          commandId: `triplex/consumer-checkpoint/init/${ContentIds.hash(
            ContentIds.Domain.consumerCheckpoint,
            request.consumer,
          )}`,
        },
      ).pipe(
        Effect.catchTag("CommandAlreadyCommittedError", () =>
          readLoaded(triples, request.consumer).pipe(
            Effect.flatMap((winner) =>
              winner?.position === request.nextPosition
                ? Effect.succeed(undefined)
                : Effect.fail(
                    conflict(request.consumer, request.expectedPosition, winner?.position),
                  ),
            ),
          ),
        ),
      );
      const stored = yield* readLoaded(triples, request.consumer);
      if (stored === null) {
        return yield* Effect.fail(
          new CorruptConsumerCheckpointError({
            consumer: request.consumer,
            message: `Consumer checkpoint ${request.consumer} was not visible after commit`,
          }),
        );
      }
      return stored;
    }

    yield* transactSystemUnjournaled(
      triples,
      [
        { op: "retract", id: current.positionTripleId },
        assertPosition(request.consumer, request.nextPosition),
      ],
      {
        ...request.meta,
        preconditions: [{ _tag: "TripleLive", id: current.positionTripleId }],
      },
    ).pipe(
      Effect.catchTag("TransactionConflictError", () =>
        readLoaded(triples, request.consumer).pipe(
          Effect.flatMap((winner) =>
            winner?.position === request.nextPosition
              ? Effect.void
              : Effect.fail(conflict(request.consumer, request.expectedPosition, winner?.position)),
          ),
        ),
      ),
    );

    const stored = yield* readLoaded(triples, request.consumer);
    if (stored === null) {
      return yield* Effect.fail(
        new CorruptConsumerCheckpointError({
          consumer: request.consumer,
          message: `Consumer checkpoint ${request.consumer} disappeared after commit`,
        }),
      );
    }
    return stored;
  });
