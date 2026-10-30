/**
 * Named, movable pointers to commit positions.
 *
 * A writer that commits a dataset over many transactions publishes it by
 * moving a ref to the last of them. Readers resolve the ref once and read at
 * `{ recordedPosition }`, so they see either the previous publication or the
 * whole new one, never a partial load. Commit positions are a total commit
 * order, so every transaction at or before a published position has
 * committed.
 *
 * A ref is an ordinary reserved Triplex entity, so every move is a journaled
 * transaction and the ref's history is the publication log: reading the ref at
 * an earlier `recordedAt` says what was published then.
 */

import { Data, Effect } from "effect";

import * as CanonicalJson from "../content/CanonicalJson.js";
import * as ContentIds from "../content/ContentId.js";
import type {
  CommandAlreadyCommittedError,
  ConstraintViolationError,
  ReadError,
  TransactionConflictError,
  WriteError,
} from "../errors/index.js";
import type { TransactionMeta, TransactionResult, TriplesService } from "../store/Triples.js";
import { transactSystem } from "../store/systemNamespace.js";
import type { TemporalBasis } from "../Temporal.js";
import type { Triple, TransactOp } from "../Triple.js";
import type { TripleValue } from "../Value.js";
import { unsafe, type EntityId, type TransactionId, type TripleId } from "../Branded.js";

export const System = {
  prefix: "_triplex/position-ref/",
  entityType: "triplex.position-ref",
  attribute: {
    name: ":triplex/position-ref-name",
    position: ":triplex/position-ref-position",
    manifest: ":triplex/position-ref-manifest",
  },
} as const;

export interface PositionRef {
  readonly name: string;
  /** The published commit position. Read at `{ recordedPosition: position }`. */
  readonly position: number;
  /** The transaction that moved the ref here. */
  readonly transactionId: TransactionId;
  /** What was published, as given to `move`. */
  readonly manifest?: CanonicalJson.CanonicalValue;
}

export interface MoveRequest {
  readonly name: string;
  /** A committed position: at most `Triples.currentPosition()`. */
  readonly position: number;
  /**
   * Move only if the ref currently points here; `null` expects no ref yet.
   * Without it the move is unconditional, but a concurrent move still
   * conflicts rather than being overwritten.
   */
  readonly expectedPosition?: number | null;
  /** JSON describing what was published, such as an import manifest. */
  readonly manifest?: CanonicalJson.CanonicalValue;
  readonly meta?: Omit<TransactionMeta, "commandId" | "preconditions" | "enforce" | "journal">;
}

export interface MoveResult {
  readonly ref: PositionRef;
  readonly transaction: TransactionResult;
}

export class InvalidPositionRefError extends Data.TaggedError("InvalidPositionRefError")<{
  readonly message: string;
}> {}

export class PositionRefConflictError extends Data.TaggedError("PositionRefConflictError")<{
  readonly name: string;
  readonly expectedPosition: number | null;
  readonly actualPosition: number | null;
  readonly message: string;
}> {}

export class PositionRefNotFoundError extends Data.TaggedError("PositionRefNotFoundError")<{
  readonly name: string;
  readonly message: string;
}> {}

export class CorruptPositionRefError extends Data.TaggedError("CorruptPositionRefError")<{
  readonly name: string;
  readonly message: string;
}> {}

export type PositionRefError =
  | InvalidPositionRefError
  | PositionRefConflictError
  | CorruptPositionRefError
  | ReadError
  | WriteError
  | TransactionConflictError
  | CommandAlreadyCommittedError
  | ConstraintViolationError;

interface Loaded extends PositionRef {
  readonly positionTripleId: TripleId;
  readonly manifestTripleId?: TripleId;
}

const validateName = (name: string): InvalidPositionRefError | undefined =>
  name.length === 0 || name.length > 1_024
    ? new InvalidPositionRefError({
        message: "Position ref name must contain between 1 and 1024 characters",
      })
    : undefined;

export const entityId = (name: string): EntityId =>
  unsafe.entityId(`${System.prefix}${ContentIds.hash(ContentIds.Domain.positionRef, name)}`);

const corrupt = (name: string, message: string) =>
  new CorruptPositionRefError({ name, message: `Position ref ${name} ${message}` });

const decode = (
  name: string,
  rows: readonly Triple[],
): Effect.Effect<Loaded | null, CorruptPositionRefError> => {
  if (rows.length === 0) return Effect.succeed(null);
  const at = (attribute: string) => rows.filter((row) => row.attribute === attribute);
  const names = at(System.attribute.name);
  const positions = at(System.attribute.position);
  const manifests = at(System.attribute.manifest);
  const stored = names[0]?.value;
  const position = positions[0]?.value;
  const manifest = manifests[0];
  if (
    names.length !== 1 ||
    positions.length !== 1 ||
    manifests.length > 1 ||
    stored?.type !== "string" ||
    stored.value !== name ||
    position?.type !== "number" ||
    !Number.isSafeInteger(position.value) ||
    position.value < 0 ||
    positions[0]!.txId._tag !== "Some" ||
    (manifest !== undefined && manifest.value.type !== "json")
  ) {
    return Effect.fail(corrupt(name, "has an invalid persisted shape"));
  }
  return Effect.succeed({
    name,
    position: position.value,
    transactionId: positions[0]!.txId.value,
    positionTripleId: positions[0]!.id,
    ...(manifest === undefined
      ? {}
      : {
          manifest: manifest.value.value as CanonicalJson.CanonicalValue,
          manifestTripleId: manifest.id,
        }),
  });
};

const load = (
  triples: TriplesService,
  name: string,
  asOf?: Pick<TemporalBasis, "recordedAt" | "recordedPosition">,
): Effect.Effect<Loaded | null, ReadError | CorruptPositionRefError> =>
  // Ref facts are valid from the epoch, so only recorded time selects a version.
  triples
    .entity(entityId(name), { ...asOf, validAt: 0 })
    .pipe(Effect.flatMap((rows) => decode(name, rows)));

const publicRef = ({ positionTripleId: _, manifestTripleId: __, ...ref }: Loaded): PositionRef =>
  ref;

/**
 * Read a ref: as it stands now, or as it stood at an earlier recorded instant
 * or position. Returns `null` for a ref that didn't exist then.
 */
export const get = (
  triples: TriplesService,
  name: string,
  asOf?: Pick<TemporalBasis, "recordedAt" | "recordedPosition">,
): Effect.Effect<
  PositionRef | null,
  InvalidPositionRefError | ReadError | CorruptPositionRefError
> => {
  const invalid = validateName(name);
  if (invalid !== undefined) return Effect.fail(invalid);
  return load(triples, name, asOf).pipe(
    Effect.map((ref) => (ref === null ? null : publicRef(ref))),
  );
};

/**
 * The read basis for a ref's published cut. Resolve it once and reuse it for
 * every read that must agree: resolving the ref per read could straddle a move.
 */
export const basis = (
  triples: TriplesService,
  name: string,
  options: { readonly validAt?: number; readonly recordedAt?: number } = {},
): Effect.Effect<
  { readonly recordedPosition: number; readonly validAt?: number },
  InvalidPositionRefError | PositionRefNotFoundError | ReadError | CorruptPositionRefError
> =>
  get(
    triples,
    name,
    options.recordedAt === undefined ? undefined : { recordedAt: options.recordedAt },
  ).pipe(
    Effect.flatMap((ref) =>
      ref === null
        ? Effect.fail(
            new PositionRefNotFoundError({ name, message: `Position ref ${name} does not exist` }),
          )
        : Effect.succeed({
            recordedPosition: ref.position,
            ...(options.validAt === undefined ? {} : { validAt: options.validAt }),
          }),
    ),
  );

const conflict = (name: string, expected: number | null, actual: number | null) =>
  new PositionRefConflictError({
    name,
    expectedPosition: expected,
    actualPosition: actual,
    message: `Position ref ${name} expected ${expected ?? "no ref"}, but found ${actual ?? "no ref"}`,
  });

const assertOp = (name: string, attribute: string, value: TripleValue): TransactOp => ({
  op: "assert",
  entityId: entityId(name),
  entityType: System.entityType,
  attribute,
  value,
  validFrom: 0,
});

/**
 * Point a ref at a committed position, in one journaled transaction. Moving
 * backwards is allowed: republishing an earlier cut is a rollback.
 */
export const move = (
  triples: TriplesService,
  request: MoveRequest,
): Effect.Effect<MoveResult, PositionRefError> =>
  Effect.gen(function* () {
    const { name, position } = request;
    const invalid = validateName(name);
    if (invalid !== undefined) return yield* invalid;
    if (!Number.isSafeInteger(position) || position < 0) {
      return yield* new InvalidPositionRefError({
        message: "Position ref position must be a non-negative safe integer",
      });
    }
    const latest = yield* triples.currentPosition();
    if (position > latest) {
      return yield* new InvalidPositionRefError({
        message: `Position ${position} is ahead of the latest committed position ${latest}`,
      });
    }
    if (request.manifest !== undefined) {
      yield* CanonicalJson.encode(request.manifest).pipe(
        Effect.mapError(
          (cause) => new InvalidPositionRefError({ message: `Invalid manifest: ${cause.message}` }),
        ),
      );
    }

    const current = yield* load(triples, name);
    const actual = current?.position ?? null;
    if (request.expectedPosition !== undefined && request.expectedPosition !== actual) {
      return yield* conflict(name, request.expectedPosition, actual);
    }

    const manifestOps: TransactOp[] =
      request.manifest === undefined
        ? []
        : [assertOp(name, System.attribute.manifest, { type: "json", value: request.manifest })];
    const meta = { actor: "triplex/position-ref", ...request.meta };
    const transaction =
      current === null
        ? yield* transactSystem(
            triples,
            [
              assertOp(name, System.attribute.name, { type: "string", value: name }),
              assertOp(name, System.attribute.position, { type: "number", value: position }),
              ...manifestOps,
            ],
            // The claim makes creation atomic: of two first moves, one wins.
            { ...meta, commandId: `triplex/position-ref/create/${entityId(name)}` },
          ).pipe(
            Effect.catchTag("CommandAlreadyCommittedError", () =>
              load(triples, name).pipe(
                Effect.flatMap((winner) =>
                  Effect.fail(
                    conflict(name, request.expectedPosition ?? null, winner?.position ?? null),
                  ),
                ),
              ),
            ),
          )
        : yield* transactSystem(
            triples,
            [
              { op: "retract", id: current.positionTripleId },
              ...(current.manifestTripleId === undefined
                ? []
                : [{ op: "retract" as const, id: current.manifestTripleId }]),
              assertOp(name, System.attribute.position, { type: "number", value: position }),
              ...manifestOps,
            ],
            { ...meta, preconditions: [{ _tag: "TripleLive", id: current.positionTripleId }] },
          ).pipe(
            Effect.catchTag("TransactionConflictError", () =>
              load(triples, name).pipe(
                Effect.flatMap((winner) =>
                  Effect.fail(conflict(name, actual, winner?.position ?? null)),
                ),
              ),
            ),
          );

    return {
      ref: {
        name,
        position,
        transactionId: transaction.txId,
        ...(request.manifest === undefined ? {} : { manifest: request.manifest }),
      },
      transaction,
    };
  });
