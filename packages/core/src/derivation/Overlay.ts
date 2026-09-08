/** Read-only hypothetical facts evaluated through the normal KV Datalog engine. */

import { Context, Data, Effect, Layer, Option, Schema } from "effect";

import * as CanonicalJson from "../content/CanonicalJson.js";
import * as ContentIds from "../content/ContentId.js";
import { unsafe } from "../Branded.js";
import { isNotClause, isPatternClause } from "../datalog/schema.js";
import type { DatalogQueryError, ReadError, WriteError } from "../errors/index.js";
import { KvTriples } from "../kv/layers/KvTriplesLive.js";
import { Triples, type TriplesService } from "../store/Triples.js";
import type { Triple, TripleInput } from "../Triple.js";
import type {
  CandidateConflictError,
  Definition,
  EvaluateOptions,
  Evaluation,
  Reader,
} from "./Derivation.js";
import { evaluate } from "./Derivation.js";

export interface Overlay {
  /** Facts visible only to this evaluation. Omitted validFrom defaults to basis.validAt. */
  readonly assertions?: readonly TripleInput[];
  /** Visible base triple IDs to hide from this evaluation. */
  readonly retractions?: readonly string[];
}

export class InvalidOverlayError extends Data.TaggedError("InvalidDerivationOverlayError")<{
  readonly message: string;
}> {}

export class UnsupportedOverlayDefinitionError extends Data.TaggedError(
  "UnsupportedDerivationOverlayDefinitionError",
)<{
  readonly definition: ContentIds.ContentId;
  readonly message: string;
}> {}

export type OverlayError =
  | ReadError
  | WriteError
  | DatalogQueryError
  | CandidateConflictError
  | CanonicalJson.CanonicalEncodingError
  | Schema.SchemaError
  | InvalidOverlayError
  | UnsupportedOverlayDefinitionError;

const patternsUseTransactions = (definition: Definition): boolean =>
  definition.query.where.some((clause) => {
    if (isPatternClause(clause)) return clause.length === 4;
    if (!isNotClause(clause)) return false;
    return clause.slice(1).some((inner) => Array.isArray(inner) && inner.length === 4);
  });

interface OverlayFactIdentity {
  readonly id: Triple["id"];
  readonly contentId: ContentIds.ContentId;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const tripleIdFromContentId = (contentId: ContentIds.ContentId): Triple["id"] => {
  let value = BigInt(`0x${contentId.slice(7, 39)}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD[Number(value & 31n)]! + encoded;
    value >>= 5n;
  }
  return unsafe.tripleId(encoded);
};

const overlayFactIdentity = (
  input: TripleInput,
): Effect.Effect<OverlayFactIdentity, CanonicalJson.CanonicalEncodingError> =>
  CanonicalJson.encode(input as unknown as CanonicalJson.CanonicalValue).pipe(
    Effect.map((encoded) => {
      const contentId = ContentIds.hash(ContentIds.Domain.derivationOverlayFact, encoded);
      return { contentId, id: tripleIdFromContentId(contentId) };
    }),
  );

const inputFrom = (triple: Triple): TripleInput => ({
  entityId: triple.entityId,
  attribute: triple.attribute,
  value: triple.value,
  ...(Option.isSome(triple.entityType) ? { entityType: triple.entityType.value } : {}),
  ...(Option.isSome(triple.createdBy) ? { createdBy: triple.createdBy.value } : {}),
  validFrom: triple.validFrom,
  ...(Option.isSome(triple.validTo) ? { validTo: triple.validTo.value } : {}),
});

/**
 * Evaluate temporary assertions and retractions without writing to `triples`.
 *
 * The overlay copies only fixed attributes discovered from the definition into
 * a fresh in-memory indexed store, applies the patch, and delegates query
 * execution to the same KV Datalog evaluator used by the normal backend. Match
 * reads are translated back to original or deterministic hypothetical triples
 * so candidate provenance remains meaningful.
 */
export const evaluateOverlay = (
  triples: TriplesService,
  definition: Definition,
  options: EvaluateOptions & { readonly overlay: Overlay },
): Effect.Effect<Evaluation, OverlayError> =>
  Effect.gen(function* () {
    if (definition.dependencies.hasDynamicAttributes) {
      return yield* new UnsupportedOverlayDefinitionError({
        definition: definition.id,
        message: "Hypothetical evaluation requires statically discoverable attributes",
      });
    }
    if (patternsUseTransactions(definition)) {
      return yield* new UnsupportedOverlayDefinitionError({
        definition: definition.id,
        message: "Hypothetical evaluation does not support transaction-binding clauses",
      });
    }

    const attributes = new Set(definition.dependencies.attributes);
    const assertions = options.overlay.assertions ?? [];
    const resolvedAssertions = assertions.map((assertion) => ({
      ...assertion,
      validFrom: assertion.validFrom ?? options.basis.validAt,
    }));
    const retractionIds = new Set(options.overlay.retractions ?? []);
    for (const assertion of assertions) {
      if (!attributes.has(assertion.attribute)) {
        return yield* new InvalidOverlayError({
          message: `Overlay assertion attribute ${assertion.attribute} is not read by ${definition.name}`,
        });
      }
    }
    if (retractionIds.size !== (options.overlay.retractions ?? []).length) {
      return yield* new InvalidOverlayError({
        message: "Overlay retractions contain duplicate IDs",
      });
    }

    const matched = yield* Effect.forEach(
      [...attributes].sort(),
      (attribute) => triples.match({ attribute }, options.basis),
      { concurrency: 16 },
    );
    const baseById = new Map(matched.flat().map((triple) => [String(triple.id), triple]));
    for (const id of retractionIds) {
      if (!baseById.has(id)) {
        return yield* new InvalidOverlayError({
          message: `Overlay retraction ${id} is not visible at the requested basis`,
        });
      }
    }
    const visibleBase = [...baseById.values()].filter(
      (triple) => !retractionIds.has(String(triple.id)),
    );
    const temporalBoundaries = [
      ...visibleBase.flatMap((triple) =>
        Option.isSome(triple.validTo) ? [triple.validTo.value] : [],
      ),
      ...resolvedAssertions.flatMap((assertion) => [assertion.validFrom, assertion.validTo]),
    ].filter(
      (boundary): boundary is number => boundary !== undefined && boundary > options.basis.validAt,
    );
    const nextTemporalBoundary =
      temporalBoundaries.length === 0 ? undefined : Math.min(...temporalBoundaries);
    const hypotheticalIdentities = yield* Effect.forEach(resolvedAssertions, overlayFactIdentity);
    if (
      new Set(hypotheticalIdentities.map((identity) => identity.contentId)).size !==
      hypotheticalIdentities.length
    ) {
      return yield* new InvalidOverlayError({
        message: "Overlay assertions contain duplicate canonical facts",
      });
    }

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(Layer.fresh(KvTriples.layer));
        const memory = Context.get(context, Triples);
        const seeded = yield* memory.assertBatch([
          ...visibleBase.map(inputFrom),
          ...resolvedAssertions,
        ]);
        const translated = new Map<string, Triple>();
        const hypotheticalContentIds = new Map<string, ContentIds.ContentId>();
        for (const [index, original] of visibleBase.entries()) {
          translated.set(String(seeded[index]!.id), original);
        }
        for (const [index, identity] of hypotheticalIdentities.entries()) {
          const ephemeral = seeded[visibleBase.length + index]!;
          translated.set(String(ephemeral.id), {
            ...ephemeral,
            id: identity.id,
            txId: Option.none(),
            createdBy: Option.none(),
          });
          hypotheticalContentIds.set(String(identity.id), identity.contentId);
        }

        const viewBasis = { validAt: options.basis.validAt };
        const reader: Reader = {
          queryAll: (query, queryOptions) =>
            memory.queryAll(query, {
              ...queryOptions,
              basis: viewBasis,
            }),
          match: (pattern) =>
            memory
              .match(pattern, viewBasis)
              .pipe(Effect.map((rows) => rows.map((row) => translated.get(String(row.id)) ?? row))),
          transaction: (txId) => triples.transaction(txId),
          temporalBoundary: () => Effect.succeed(nextTemporalBoundary),
          sourceMetadata: (triple) => {
            const hypotheticalContentId = hypotheticalContentIds.get(String(triple.id));
            return hypotheticalContentId === undefined
              ? {}
              : { hypothetical: true, hypotheticalContentId };
          },
        };
        return yield* evaluate(reader, definition, { basis: options.basis });
      }),
    );
  });
