import { Data, Effect, Option, Schema } from "effect";

import type { ContentId } from "../content/ContentId.js";
import * as ContentIds from "../content/ContentId.js";
import * as CanonicalJson from "../content/CanonicalJson.js";
import type { Constant, DatalogQuery, PatternClause, Term } from "../datalog/types.js";
import { isNotClause, isPatternClause, isPredicateClause, isVariable } from "../datalog/schema.js";
import type { TemporalBasis } from "../Temporal.js";
import type { Triple } from "../Triple.js";
import type { TransactionRecord, TriplesService } from "../store/Triples.js";
import type { TripleValue } from "../Value.js";
import type { DatalogQueryError, ReadError } from "../errors/index.js";
import { extractDependencies } from "../subscriptions/extract-dependencies.js";
import * as TypeExpr from "../config/TypeExpr.js";
import * as TypeSchema from "../config/TypeSchema.js";
import { unsafe, type EntityId, type TransactionId, type TripleId } from "../Branded.js";

export class DefinitionError extends Data.TaggedError("DerivationDefinitionError")<{
  readonly message: string;
}> {}

export class CandidateConflictError extends Data.TaggedError("DerivationCandidateConflictError")<{
  readonly definition: ContentId;
  readonly candidate: ContentId;
  readonly message: string;
}> {}

export interface Definition {
  readonly name: string;
  readonly query: DatalogQuery;
  readonly identity: readonly string[];
  readonly output: readonly string[];
  readonly configSnapshot: string;
  readonly resultType?: TypeExpr.TypeExpr;
  readonly dependencies: Dependencies;
  readonly id: ContentId;
}

export interface Dependencies {
  readonly attributes: readonly string[];
  readonly entityTypes: readonly string[];
  readonly boundEntityIds: readonly string[];
  readonly hasDynamicAttributes: boolean;
}

export interface DefinitionInput {
  readonly name: string;
  readonly query: DatalogQuery;
  /** Variables whose values form the stable candidate identity. */
  readonly identity: readonly string[];
  /** Public result variables. Defaults to variable terms in `query.find`. */
  readonly output?: readonly string[];
  readonly configSnapshot: string;
  /** Optional runtime type for the public result binding. */
  readonly resultType?: TypeExpr.TypeExpr;
}

const unique = <A>(values: readonly A[]): A[] => [...new Set(values)];
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const definitionBody = (
  input: DefinitionInput,
  output: readonly string[],
  dependencies: Dependencies,
) => ({
  version: 1,
  name: input.name,
  query: input.query,
  identity: input.identity,
  output,
  configSnapshot: input.configSnapshot,
  resultType: input.resultType ? TypeExpr.id(input.resultType) : null,
  dependencies,
});

export const make = (
  input: DefinitionInput,
): Effect.Effect<Definition, DefinitionError | CanonicalJson.CanonicalEncodingError> =>
  Effect.gen(function* () {
    const output = input.output ?? input.query.find.filter(isVariable);
    if (input.name.length === 0) {
      return yield* new DefinitionError({ message: "A derivation name must not be empty" });
    }
    if (input.identity.length === 0 || input.identity.some((term) => !isVariable(term))) {
      return yield* new DefinitionError({
        message: "Derivation identity must contain at least one Datalog variable",
      });
    }
    if (output.some((term) => !isVariable(term))) {
      return yield* new DefinitionError({ message: "Derivation output entries must be variables" });
    }
    if (input.identity.some((variable) => !output.includes(variable))) {
      return yield* new DefinitionError({
        message: "Every derivation identity variable must be part of its public output",
      });
    }
    if (
      input.query.aggregate?.length ||
      input.query.rules?.length ||
      input.query.limit !== undefined ||
      input.query.offset !== undefined ||
      input.query.where.some(
        (clause) => !isPatternClause(clause) && !isPredicateClause(clause) && !isNotClause(clause),
      )
    ) {
      return yield* new DefinitionError({
        message:
          "Provenance derivations currently support complete structural Datalog queries without rules, disjunction, aggregation, limit, or offset",
      });
    }
    const discovered = extractDependencies(input.query);
    const dependencies: Dependencies = {
      attributes: [...discovered.attributes].sort(compare),
      entityTypes: [...discovered.entityTypes].sort(compare),
      boundEntityIds: [...discovered.boundEntityIds].sort(compare),
      hasDynamicAttributes: discovered.hasDynamicAttributes,
    };
    const encoded = yield* CanonicalJson.encode(
      definitionBody(input, output, dependencies) as unknown as CanonicalJson.CanonicalValue,
    );
    return {
      ...input,
      output,
      dependencies,
      id: ContentIds.hash(ContentIds.Domain.derivationDefinition, encoded),
    };
  });

export interface SourceFact {
  readonly tripleId: TripleId;
  readonly transactionId?: TransactionId;
  readonly transactionPosition?: number;
  readonly entityId: EntityId;
  readonly attribute: string;
  readonly validFrom: number;
  readonly validTo?: number;
  /** True when the source exists only in a read-only hypothetical overlay. */
  readonly hypothetical?: boolean;
  /** Content commitment for a hypothetical fact input. */
  readonly hypotheticalContentId?: ContentId;
}

export interface Candidate {
  /** Stable across provenance and output revisions for the same logical key. */
  readonly id: ContentId;
  /** Changes when the result or its explanation changes. */
  readonly revision: ContentId;
  readonly definitionId: ContentId;
  readonly configSnapshot: string;
  readonly identity: Readonly<Record<string, Constant | null>>;
  readonly result: Readonly<Record<string, Constant | null>>;
  readonly basis: TemporalBasis;
  readonly sources: readonly SourceFact[];
  readonly nextTemporalBoundary?: number;
}

export interface Evaluation {
  readonly definition: Definition;
  readonly basis: TemporalBasis;
  readonly candidates: readonly Candidate[];
  /** Earliest valid-time instant at which this evaluation may change without a new transaction. */
  readonly nextTemporalBoundary?: number;
}

export interface EvaluateOptions {
  /** Callers pin valid time so an evaluation can be replayed. */
  readonly basis: TemporalBasis & { readonly validAt: number };
}

const positivePatterns = (query: DatalogQuery): PatternClause[] =>
  query.where.filter(isPatternClause);

const variablesInPatterns = (patterns: readonly PatternClause[]): string[] =>
  unique(patterns.flatMap((pattern) => pattern.filter(isVariable)));

const tripleValueConstant = (value: TripleValue): Constant => {
  switch (value.type) {
    case "json":
      return JSON.stringify(value.value);
    default:
      return value.value;
  }
};

const termValue = (term: Term, row: Readonly<Record<string, Constant | null>>): Constant | null =>
  isVariable(term) ? (row[term] ?? null) : term;

const normalizedConstant = (value: Constant | null): Constant | null =>
  typeof value === "object" && value !== null && "type" in value ? value.value : value;

const termMatches = (
  term: Term,
  actual: Constant | null,
  row: Readonly<Record<string, Constant | null>>,
): boolean => normalizedConstant(termValue(term, row)) === normalizedConstant(actual);

const tripleMatches = (
  triple: Triple,
  clause: PatternClause,
  row: Readonly<Record<string, Constant | null>>,
): boolean =>
  termMatches(clause[0], triple.entityId, row) &&
  termMatches(clause[1], triple.attribute, row) &&
  termMatches(clause[2], tripleValueConstant(triple.value), row) &&
  (clause.length === 3 || termMatches(clause[3], Option.getOrNull(triple.txId), row));

export interface Reader extends Pick<TriplesService, "match" | "queryAll" | "transaction"> {
  /** Indexed freshness and temporal scheduling when backed by a full store. */
  readonly dependencyState?: TriplesService["dependencyState"];
  /** Ordered journal access enables discovery of future valid-time boundaries. */
  readonly transactions?: TriplesService["transactions"];
  /** Private views may provide their own bounded temporal schedule. */
  readonly temporalBoundary?: (
    definition: Definition,
    basis: EvaluateOptions["basis"],
  ) => Effect.Effect<number | undefined, ReadError>;
  /** Optional provenance supplied by a private read view such as an overlay. */
  readonly sourceMetadata?: (triple: Triple) => {
    readonly hypothetical?: boolean;
    readonly hypotheticalContentId?: ContentId;
  };
}

const transactionIsRelevant = (definition: Definition, transaction: TransactionRecord): boolean => {
  if (transaction.actor === "triplex/derivation-materializer") return false;
  const attributes = new Set(definition.dependencies.attributes);
  return transaction.changes.some(
    (change) => definition.dependencies.hasDynamicAttributes || attributes.has(change.attribute),
  );
};

/**
 * Find the earliest future valid-time edge in the current recorded view.
 *
 * Full Triples stores use their indexed dependency state. Restricted readers
 * may provide a private schedule; dynamic-attribute readers fall back to the
 * portable journal. All paths are conservative for query relevance: an
 * unrelated entity may cause an extra wakeup, but cannot cause a missed one.
 */
const temporalBoundaryFromJournal = (
  triples: Reader,
  definition: Definition,
  basis: EvaluateOptions["basis"],
): Effect.Effect<number | undefined, ReadError> =>
  Effect.gen(function* () {
    if (triples.temporalBoundary) return yield* triples.temporalBoundary(definition, basis);
    if (triples.dependencyState && !definition.dependencies.hasDynamicAttributes) {
      return (yield* triples.dependencyState(definition.dependencies.attributes, basis))
        .nextTemporalBoundary;
    }
    if (!triples.transactions) return undefined;

    const attributes = new Set(definition.dependencies.attributes);
    const live = new Map<string, { readonly validFrom?: number; readonly validTo?: number }>();
    let after = 0;
    while (true) {
      const page = yield* triples.transactions({ after, limit: 1_000 });
      for (const transaction of page.transactions) {
        if (basis.recordedAt !== undefined && transaction.instant > basis.recordedAt) continue;
        if (!transactionIsRelevant(definition, transaction)) continue;
        for (const change of transaction.changes) {
          if (!definition.dependencies.hasDynamicAttributes && !attributes.has(change.attribute)) {
            continue;
          }
          if (change.op === "retract") {
            live.delete(change.tripleId);
          } else {
            live.set(change.tripleId, {
              ...(change.validFrom === undefined ? {} : { validFrom: change.validFrom }),
              ...(change.validTo === undefined ? {} : { validTo: change.validTo }),
            });
          }
        }
      }
      if (page.next === undefined || page.next <= after || page.transactions.length < 1_000) break;
      after = page.next;
    }

    const boundaries = [...live.values()].flatMap((fact) =>
      [fact.validFrom, fact.validTo].filter(
        (value): value is number => value !== undefined && value > basis.validAt,
      ),
    );
    return boundaries.length === 0 ? undefined : Math.min(...boundaries);
  });

const sourcesForRow = (
  triples: Reader,
  patterns: readonly PatternClause[],
  row: Readonly<Record<string, Constant | null>>,
  basis: TemporalBasis,
  transactionPositions: Map<string, number | undefined>,
): Effect.Effect<readonly SourceFact[], ReadError> =>
  Effect.gen(function* () {
    const found = new Map<string, Triple>();
    for (const clause of patterns) {
      const entity = normalizedConstant(termValue(clause[0], row));
      const attribute = normalizedConstant(termValue(clause[1], row));
      const matches = yield* triples.match(
        {
          ...(typeof entity === "string" ? { entityId: unsafe.entityId(entity) } : {}),
          ...(typeof attribute === "string" ? { attribute } : {}),
        },
        basis,
      );
      for (const triple of matches) {
        if (tripleMatches(triple, clause, row)) found.set(triple.id, triple);
      }
    }

    return yield* Effect.forEach(
      [...found.values()].sort((left, right) => compare(left.id, right.id)),
      (triple) =>
        Effect.gen(function* () {
          const transactionId = Option.getOrUndefined(triple.txId);
          const sourceMetadata = triples.sourceMetadata?.(triple);
          let transactionPosition: number | undefined;
          if (transactionId) {
            if (!transactionPositions.has(transactionId)) {
              const transaction = yield* triples.transaction(transactionId);
              transactionPositions.set(transactionId, transaction?.position);
            }
            transactionPosition = transactionPositions.get(transactionId);
          }
          return {
            tripleId: triple.id,
            ...(transactionId ? { transactionId } : {}),
            ...(transactionPosition !== undefined ? { transactionPosition } : {}),
            entityId: triple.entityId,
            attribute: triple.attribute,
            validFrom: triple.validFrom,
            ...(Option.isSome(triple.validTo) ? { validTo: triple.validTo.value } : {}),
            ...sourceMetadata,
          } satisfies SourceFact;
        }),
      { concurrency: 16 },
    );
  });

const binding = (
  variables: readonly string[],
  row: Readonly<Record<string, Constant | null>>,
): Record<string, Constant | null> =>
  Object.fromEntries(variables.map((variable) => [variable, row[variable] ?? null]));

export const candidateIdentityId = (
  definitionName: string,
  identity: Readonly<Record<string, Constant | null>>,
): ContentId => {
  const encoded = CanonicalJson.encodeOrThrow({
    derivation: definitionName,
    identity,
  } as unknown as CanonicalJson.CanonicalValue);
  return ContentIds.hash(ContentIds.Domain.derivationIdentity, encoded);
};

export const candidateRevisionId = (input: {
  readonly id: ContentId;
  readonly definitionId: ContentId;
  readonly configSnapshot: string;
  readonly result: Readonly<Record<string, Constant | null>>;
  readonly sources: readonly SourceFact[];
}): ContentId => {
  const encoded = CanonicalJson.encodeOrThrow({
    id: input.id,
    definition: input.definitionId,
    configSnapshot: input.configSnapshot,
    result: input.result,
    sources: input.sources,
  } as unknown as CanonicalJson.CanonicalValue);
  return ContentIds.hash(ContentIds.Domain.derivationCandidate, encoded);
};

const candidateFrom = (
  definition: Definition,
  basis: TemporalBasis & { readonly validAt: number },
  identity: Readonly<Record<string, Constant | null>>,
  result: Readonly<Record<string, Constant | null>>,
  sources: readonly SourceFact[],
): Candidate => {
  const id = candidateIdentityId(definition.name, identity);
  const revision = candidateRevisionId({
    id,
    definitionId: definition.id,
    configSnapshot: definition.configSnapshot,
    result,
    sources,
  });
  const boundaries = sources
    .map((source) => source.validTo)
    .filter((value): value is number => value !== undefined && value > basis.validAt);
  return {
    id,
    revision,
    definitionId: definition.id,
    configSnapshot: definition.configSnapshot,
    identity,
    result,
    basis,
    sources,
    ...(boundaries.length > 0 ? { nextTemporalBoundary: Math.min(...boundaries) } : {}),
  };
};

export const evaluate = (
  triples: Reader,
  definition: Definition,
  options: EvaluateOptions,
): Effect.Effect<
  Evaluation,
  | ReadError
  | DatalogQueryError
  | CanonicalJson.CanonicalEncodingError
  | Schema.SchemaError
  | CandidateConflictError
> =>
  Effect.gen(function* () {
    const patterns = positivePatterns(definition.query);
    const internalVariables = variablesInPatterns(patterns);
    const augmentedQuery: DatalogQuery = {
      ...definition.query,
      find: unique([...definition.query.find, ...internalVariables]),
    };
    const [response, nextTemporalBoundary] = yield* Effect.all([
      triples.queryAll(augmentedQuery, { basis: options.basis }),
      temporalBoundaryFromJournal(triples, definition, options.basis),
    ]);
    const grouped = new Map<ContentId, Candidate>();
    const transactionPositions = new Map<string, number | undefined>();

    for (const row of response.results) {
      const publicResult = binding(definition.output, row);
      const normalizedResult = definition.resultType
        ? ((yield* TypeSchema.normalize(definition.resultType, publicResult)) as Record<
            string,
            Constant | null
          >)
        : publicResult;
      const identity = binding(definition.identity, normalizedResult);
      const sources = yield* sourcesForRow(
        triples,
        patterns,
        row,
        options.basis,
        transactionPositions,
      );
      const candidate = candidateFrom(
        definition,
        options.basis,
        identity,
        normalizedResult,
        sources,
      );
      const previous = grouped.get(candidate.id);
      if (!previous) {
        grouped.set(candidate.id, candidate);
        continue;
      }
      if (
        CanonicalJson.encodeOrThrow(previous.result as CanonicalJson.CanonicalValue) !==
        CanonicalJson.encodeOrThrow(candidate.result as CanonicalJson.CanonicalValue)
      ) {
        return yield* new CandidateConflictError({
          definition: definition.id,
          candidate: candidate.id,
          message: `Derivation ${definition.name} produced different results for the same identity`,
        });
      }
      const mergedSources = [
        ...new Map(
          [...previous.sources, ...candidate.sources].map((source) => [source.tripleId, source]),
        ).values(),
      ].sort((left, right) => compare(left.tripleId, right.tripleId));
      grouped.set(
        candidate.id,
        candidateFrom(definition, options.basis, identity, normalizedResult, mergedSources),
      );
    }

    return {
      definition,
      basis: options.basis,
      candidates: [...grouped.values()].sort((left, right) => compare(left.id, right.id)),
      ...(nextTemporalBoundary === undefined ? {} : { nextTemporalBoundary }),
    };
  });

export interface Reconciliation {
  readonly added: readonly Candidate[];
  readonly removed: readonly Candidate[];
  readonly changed: readonly { readonly before: Candidate; readonly after: Candidate }[];
  readonly unchanged: readonly Candidate[];
}

export const reconcile = (
  previous: readonly Candidate[],
  current: readonly Candidate[],
): Reconciliation => {
  const before = new Map(previous.map((candidate) => [candidate.id, candidate]));
  const after = new Map(current.map((candidate) => [candidate.id, candidate]));
  const added: Candidate[] = [];
  const removed: Candidate[] = [];
  const changed: Array<{ before: Candidate; after: Candidate }> = [];
  const unchanged: Candidate[] = [];

  for (const candidate of current) {
    const prior = before.get(candidate.id);
    if (!prior) added.push(candidate);
    else if (prior.revision !== candidate.revision)
      changed.push({ before: prior, after: candidate });
    else unchanged.push(candidate);
  }
  for (const candidate of previous) if (!after.has(candidate.id)) removed.push(candidate);

  added.sort((left, right) => compare(left.id, right.id));
  removed.sort((left, right) => compare(left.id, right.id));
  changed.sort((left, right) => compare(left.after.id, right.after.id));
  unchanged.sort((left, right) => compare(left.id, right.id));
  return { added, removed, changed, unchanged };
};
