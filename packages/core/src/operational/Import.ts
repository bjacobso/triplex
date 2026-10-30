/**
 * Incremental, non-blocking loads of large datasets, published atomically.
 *
 * `run` commits the facts in chunks, one transaction each, and yields to the
 * host between chunks so a browser can paint and a server can interleave other
 * work. With `ref`, one final transaction moves a `PositionRef` to the last
 * chunk's position. Readers at that ref see the previous publication until the
 * move and the whole import after it, never part of it.
 *
 * Readers that don't go through the ref read the latest state and do see the
 * chunks as they commit. If the import fails part way, the committed chunks
 * stay (facts are append-only) but the ref doesn't move.
 */

import { Data, Effect, Stream } from "effect";

import * as CanonicalJson from "../content/CanonicalJson.js";
import * as ContentIds from "../content/ContentId.js";
import type {
  CommandAlreadyCommittedError,
  ConstraintViolationError,
  ReadError,
  TransactionConflictError,
  WriteError,
} from "../errors/index.js";
import type { TransactionId } from "../Branded.js";
import type {
  TransactionMeta,
  TransactionResult,
  TransactionSummary,
  TriplesService,
} from "../store/Triples.js";
import { transactionChangeFromTriple, transactionSummary } from "../store/transactionMetadata.js";
import type { TransactOp, TripleInput } from "../Triple.js";
import { generateId } from "../utils/id.js";
import * as PositionRef from "./PositionRef.js";
import * as Segment from "./Segment.js";

export interface Options<PE = never, PR = never> {
  /** Assertions per transaction. Defaults to 2,000. */
  readonly chunkSize?: number;
  /**
   * How each chunk is committed. `"transactions"` (the default) asserts its
   * facts with `transact`. `"segments"` builds each chunk into an immutable
   * `Segment` and attaches it in one transaction; only the in-memory KV
   * backend supports it. See `Segment.attach`.
   */
  readonly store?: "transactions" | "segments";
  /**
   * Journal shape for each chunk's transaction. Defaults to `"summary"`: one
   * compact entry per chunk instead of one per fact. See `TransactionMeta.journal`.
   */
  readonly journal?: "changes" | "summary";
  /** Move this `PositionRef` to the last chunk's position once every chunk has committed. */
  readonly ref?: string;
  /** Compare-and-move for `ref`, as `PositionRef.move`'s `expectedPosition`. */
  readonly expectedRefPosition?: number | null;
  /**
   * Metadata for every chunk and for the ref move. `correlationId` defaults to
   * the import ID, which links the chunks in the journal.
   */
  readonly meta?: Omit<TransactionMeta, "commandId" | "preconditions" | "enforce" | "journal">;
  /**
   * Runs after each chunk commits. Defaults to `yieldToHost`, a macrotask, so
   * the host's event loop (and a browser's rendering) runs between chunks.
   */
  readonly yieldBetweenChunks?: Effect.Effect<void, PE, PR>;
  readonly onProgress?: (progress: Progress) => Effect.Effect<void, PE, PR>;
}

export interface Progress {
  readonly importId: string;
  /** Chunks committed so far. */
  readonly chunks: number;
  /** Facts committed so far. */
  readonly facts: number;
  /** Position of the chunk that just committed. */
  readonly position: number;
}

/** What an import committed. Also stored with the ref, as its manifest. */
export interface Manifest {
  readonly importId: string;
  readonly facts: number;
  readonly chunks: number;
  /**
   * First and last chunk positions. Other writers' transactions can commit in
   * between; a reader at `lastPosition` sees those too.
   */
  readonly firstPosition: number;
  readonly lastPosition: number;
  /** `ContentId` over the chunks' summary digests, in order. */
  readonly digest: string;
}

export interface Result extends Manifest {
  readonly transactions: readonly TransactionId[];
  /** The moved ref, when `ref` was given. */
  readonly ref?: PositionRef.PositionRef;
}

export class InvalidImportError extends Data.TaggedError("InvalidImportError")<{
  readonly message: string;
}> {}

export type ImportError =
  | InvalidImportError
  | PositionRef.PositionRefError
  | ReadError
  | WriteError
  | TransactionConflictError
  | CommandAlreadyCommittedError
  | ConstraintViolationError;

/** Yield to the host's event loop: resume on a fresh macrotask. */
export const yieldToHost: Effect.Effect<void> = Effect.callback<void>((resume) => {
  const handle = setTimeout(() => resume(Effect.void), 0);
  return Effect.sync(() => clearTimeout(handle));
});

const summaryOf = (result: TransactionResult): TransactionSummary =>
  result.summary ??
  transactionSummary(
    result.triples.map((triple) =>
      transactionChangeFromTriple("assert", triple, result.txId, result.instant),
    ),
  );

/**
 * Commit `facts` in chunks and, with `ref`, publish them by moving the ref.
 * An empty import commits nothing and moves the ref to the current position.
 */
export const run = <E = never, R = never, PE = never, PR = never>(
  triples: TriplesService,
  facts: Iterable<TripleInput> | Stream.Stream<TripleInput, E, R>,
  options: Options<PE, PR> = {},
): Effect.Effect<Result, ImportError | E | PE, R | PR> =>
  Effect.gen(function* () {
    const chunkSize = options.chunkSize ?? 2_000;
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
      return yield* new InvalidImportError({
        message: "Import chunk size must be a positive integer",
      });
    }
    if (options.ref !== undefined && (options.ref.length === 0 || options.ref.length > 1_024)) {
      return yield* new PositionRef.InvalidPositionRefError({
        message: "Position ref name must contain between 1 and 1024 characters",
      });
    }
    const importId = options.meta?.correlationId ?? `import/${generateId()}`;
    const meta: TransactionMeta = {
      ...options.meta,
      correlationId: importId,
      journal: options.journal ?? "summary",
    };
    const between: Effect.Effect<void, PE, PR> = options.yieldBetweenChunks ?? yieldToHost;

    const transactions: TransactionId[] = [];
    const digests: string[] = [];
    let factCount = 0;
    let firstPosition: number | undefined;
    let lastPosition: number | undefined;

    const commit = (chunk: readonly TripleInput[]) =>
      Effect.gen(function* () {
        const result =
          options.store === "segments"
            ? yield* Segment.attach(triples, Segment.build(chunk), {
                ...options.meta,
                correlationId: importId,
              })
            : yield* triples.transact(
                chunk.map((fact): TransactOp => ({ ...fact, op: "assert" })),
                meta,
              );
        transactions.push(result.txId);
        digests.push(summaryOf(result).digest);
        factCount += chunk.length;
        firstPosition ??= result.position;
        lastPosition = result.position;
        if (options.onProgress) {
          yield* options.onProgress({
            importId,
            chunks: transactions.length,
            facts: factCount,
            position: result.position,
          });
        }
        yield* between;
      });

    if (Stream.isStream(facts)) {
      yield* facts.pipe(Stream.grouped(chunkSize), Stream.runForEach(commit));
    } else {
      let chunk: TripleInput[] = [];
      for (const fact of facts) {
        chunk.push(fact);
        if (chunk.length === chunkSize) {
          yield* commit(chunk);
          chunk = [];
        }
      }
      if (chunk.length > 0) yield* commit(chunk);
    }

    const current = lastPosition ?? (yield* triples.currentPosition());
    const manifest: Manifest = {
      importId,
      facts: factCount,
      chunks: transactions.length,
      firstPosition: firstPosition ?? current,
      lastPosition: current,
      digest: ContentIds.hash(
        ContentIds.Domain.importManifest,
        CanonicalJson.encodeOrThrow(digests),
      ),
    };
    if (options.ref === undefined) return { ...manifest, transactions };

    const moved = yield* PositionRef.move(triples, {
      name: options.ref,
      position: current,
      manifest: { ...manifest },
      ...(options.expectedRefPosition === undefined
        ? {}
        : { expectedPosition: options.expectedRefPosition }),
      meta: { ...options.meta, correlationId: importId },
    });
    return { ...manifest, transactions, ref: moved.ref };
  });
