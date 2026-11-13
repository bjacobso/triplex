import { Clock, Context, Effect, Layer, Option } from "effect";
import type { EntityId, TripleId, TransactionId } from "../Branded.js";
import * as CanonicalJson from "../content/CanonicalJson.js";
import type { ContentId } from "../content/ContentId.js";
import * as ConfigStore from "../config/ConfigStore.js";
import * as Derivation from "../derivation/Derivation.js";
import { Sensitivity } from "../sensitive/Sensitive.js";
import type { Triple } from "../Triple.js";
import { withoutBlind, type TripleValue } from "../Value.js";
import { Triples, type TransactionRecord } from "../store/Triples.js";
import {
  WhyInvalidRequest,
  WhySubjectNotFound,
  WhyCandidateRevisionMismatch,
  WhyIncompleteHistory,
} from "../errors/index.js";
export {
  WhyInvalidRequest,
  WhySubjectNotFound,
  WhyCandidateRevisionMismatch,
  WhyIncompleteHistory,
} from "../errors/index.js";

export interface BasisInput {
  readonly validAt?: number;
  readonly recordedAt?: number;
  readonly recordedPosition?: number;
}
export type WhySubject =
  | { readonly kind: "fact"; readonly tripleId: TripleId }
  | { readonly kind: "attribute"; readonly entityId: EntityId; readonly attribute: string }
  | { readonly kind: "entity"; readonly entityId: EntityId }
  | {
      readonly kind: "candidate";
      readonly definition: Derivation.Definition;
      readonly candidateId: ContentId;
      readonly revision: ContentId;
    };
export interface WhyOptions {
  readonly basis?: BasisInput;
  readonly causationDepth?: number;
}
export type Release =
  | { readonly status: "unpinned" }
  | { readonly status: "missing"; readonly id: string }
  | {
      readonly status: "found";
      readonly id: string;
      readonly label: string;
      readonly rootCid: ContentId;
    };
export interface TransactionExplanation {
  readonly txId: TransactionId;
  readonly position: number;
  readonly instant: number;
  readonly actor: string | null;
  readonly commandId: string | null;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly release: Release;
}
export interface FactExplanation {
  readonly tripleId: TripleId;
  readonly entityId: EntityId;
  readonly entityType: string | null;
  readonly attribute: string;
  readonly value: TripleValue;
  readonly valid: { readonly from: number; readonly to: number | null };
  readonly recorded: { readonly from: number; readonly to: number | null };
  readonly visible: boolean;
  readonly assertion: TransactionId | null;
  readonly retraction: TransactionId | null;
}
export interface CausationTrace {
  readonly start: TransactionId;
  readonly ancestors: readonly TransactionId[];
  readonly stop:
    | { readonly reason: "disabled" | "root" }
    | { readonly reason: "depth-limit" | "missing" | "after-basis"; readonly commandId: string }
    | { readonly reason: "cycle"; readonly commandId: string; readonly txId: TransactionId };
}
export interface Explanation {
  readonly version: 1;
  readonly subject:
    | Exclude<WhySubject, { kind: "candidate" }>
    | { readonly kind: "candidate"; readonly candidateId: ContentId; readonly revision: ContentId };
  readonly basis: { readonly validAt: number; readonly recordedPosition: number };
  readonly facts: readonly FactExplanation[];
  readonly transactions: readonly TransactionExplanation[];
  readonly derivation: null | {
    readonly name: string;
    readonly candidate: Derivation.Candidate;
    readonly release: Release;
    readonly evaluationNextTemporalBoundary: number | null;
  };
  readonly causation: { readonly maxDepth: number; readonly traces: readonly CausationTrace[] };
  readonly gaps: readonly {
    readonly kind: "missing-assertion" | "missing-retraction";
    readonly tripleId: TripleId;
    readonly txId: TransactionId | null;
  }[];
}
export type WhyError =
  | Effect.Error<ReturnType<typeof Derivation.evaluate>>
  | ConfigStore.LoadError
  | WhyInvalidRequest
  | WhySubjectNotFound
  | WhyCandidateRevisionMismatch
  | WhyIncompleteHistory;
export interface WhyService {
  readonly why: (subject: WhySubject, options?: WhyOptions) => Effect.Effect<Explanation, WhyError>;
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class Why extends Context.Service<Why, WhyService>()("triplex/Why") {
  static readonly layer = Layer.effect(
    Why,
    Effect.gen(function* () {
      const triples = yield* Triples;
      const config = yield* ConfigStore.ConfigStore;
      const sensitivity = yield* Effect.serviceOption(Sensitivity);
      // Request-local caches keep every receipt filtered against that request's cut.
      const why: WhyService["why"] = (subject, options = {}) =>
        Effect.gen(function* () {
          const subjectId =
            subject.kind === "fact"
              ? subject.tripleId
              : subject.kind === "candidate"
                ? subject.candidateId
                : subject.entityId;
          const invalid = (reason: string) =>
            new WhyInvalidRequest({ subjectId, reason, message: "Invalid explanation request" });
          const incomplete = (reason: string) =>
            new WhyIncompleteHistory({
              subjectId,
              reason,
              message: "Incomplete explanation history",
            });
          const missing = () =>
            new WhySubjectNotFound({
              subjectId,
              reason: "not-at-basis",
              message: "Explanation subject not found at basis",
            });
          const depth = options.causationDepth ?? 0;
          const input = options.basis ?? {};
          if (!Number.isInteger(depth) || depth < 0 || depth > 32)
            return yield* invalid("causation-depth");
          if (
            (input.validAt !== undefined &&
              (!Number.isFinite(input.validAt) || input.validAt < 0)) ||
            (input.recordedAt !== undefined && !Number.isFinite(input.recordedAt)) ||
            (input.recordedPosition !== undefined &&
              (!Number.isSafeInteger(input.recordedPosition) || input.recordedPosition < 0)) ||
            (input.recordedAt !== undefined && input.recordedPosition !== undefined)
          )
            return yield* invalid("basis");
          if (
            subject.kind === "candidate" &&
            (input.validAt === undefined ||
              (input.recordedAt === undefined && input.recordedPosition === undefined))
          )
            return yield* invalid("candidate-basis-required");
          const validAt = input.validAt ?? (yield* Clock.currentTimeMillis);
          // Resolve once; a supplied position is validated against that captured head here.
          const captured = yield* triples.resolveRecordedBasis(
            input.recordedPosition === undefined ? input : {},
          );
          if (input.recordedPosition !== undefined) {
            if (input.recordedPosition > captured.recordedPosition)
              return yield* invalid("basis-ahead");
          }
          const cut = { recordedPosition: input.recordedPosition ?? captured.recordedPosition };
          const basis = { ...cut, validAt };
          const receipts = new Map<TransactionId, TransactionRecord | null>();
          const commands = new Map<string, TransactionRecord | null>();
          const releases = new Map<string, Release>();
          const included = new Map<TransactionId, TransactionRecord>();
          const starts = new Map<TransactionId, TransactionRecord>();
          const gaps: Explanation["gaps"][number][] = [];
          const receipt = (id: TransactionId) =>
            Effect.gen(function* () {
              if (receipts.has(id)) return receipts.get(id)!;
              const result = yield* triples.transaction(id);
              if (
                result &&
                (result.txId !== id ||
                  !Number.isSafeInteger(result.position) ||
                  result.position < 1 ||
                  !Number.isFinite(result.instant))
              )
                return yield* incomplete("inconsistent-receipt");
              receipts.set(id, result);
              return result;
            });
          const release = (id: string | undefined): Effect.Effect<Release, ConfigStore.LoadError> =>
            Effect.gen(function* () {
              if (id === undefined) return { status: "unpinned" } as const;
              if (releases.has(id)) return releases.get(id)!;
              const snapshot = /^sha256-[0-9a-f]{64}$/.test(id)
                ? yield* config.snapshotById(id as ContentId)
                : undefined;
              const result: Release = snapshot
                ? {
                    status: "found",
                    id: snapshot.id,
                    label: snapshot.label,
                    rootCid: snapshot.rootCid,
                  }
                : { status: "missing", id };
              releases.set(id, result);
              return result;
            });
          const entityJournals = new Map<EntityId, readonly TransactionRecord[]>();
          const journals = (entityId: EntityId) =>
            Effect.gen(function* () {
              if (entityJournals.has(entityId)) return entityJournals.get(entityId)!;
              const found: TransactionRecord[] = [];
              let beforePosition: number | undefined;
              do {
                const page = yield* triples.transactionsForEntity(entityId, {
                  snapshotPosition: cut.recordedPosition,
                  limit: 1000,
                  ...(beforePosition === undefined ? {} : { beforePosition }),
                });
                found.push(...page.transactions);
                beforePosition = page.nextBeforePosition;
              } while (beforePosition !== undefined);
              entityJournals.set(entityId, found);
              return found;
            });
          const consistentChange = (
            tx: TransactionRecord,
            fact: Triple,
            op: "assert" | "retract",
          ) =>
            Effect.gen(function* () {
              const changes = tx.changes.filter((c) => c.op === op && c.tripleId === fact.id);
              if (changes.length !== 1) return false;
              const change = changes[0]!;
              if (
                change.entityId !== fact.entityId ||
                change.attribute !== fact.attribute ||
                (change.entityType !== undefined &&
                  change.entityType !== Option.getOrUndefined(fact.entityType)) ||
                (change.validFrom !== undefined &&
                  (change.validFrom !== fact.validFrom ||
                    change.validTo !== Option.getOrUndefined(fact.validTo))) ||
                (change.recordedAt !== undefined && change.recordedAt !== fact.recordedAt)
              )
                return false;
              if (change.value !== undefined) {
                // Journal copies of sealed values carry no blind token.
                const stored = yield* CanonicalJson.encode(
                  withoutBlind(fact.value) as CanonicalJson.CanonicalValue,
                );
                const journal = yield* CanonicalJson.encode(
                  change.value as CanonicalJson.CanonicalValue,
                );
                if (stored !== journal) return false;
              }
              return true;
            });
          const expand = (fact: Triple) =>
            Effect.gen(function* () {
              if (
                ![fact.recordedAt, fact.validFrom].every(Number.isFinite) ||
                (Option.isSome(fact.validTo) && !Number.isFinite(fact.validTo.value))
              )
                return yield* incomplete("invalid-fact-time");
              const assertionId = Option.getOrNull(fact.txId);
              let assertion = assertionId ? yield* receipt(assertionId) : null;
              if (!assertion) {
                assertion =
                  (yield* journals(fact.entityId)).find((tx) =>
                    tx.changes.some((c) => c.op === "assert" && c.tripleId === fact.id),
                  ) ?? null;
                if (assertion && assertionId && assertion.txId !== assertionId)
                  return yield* incomplete("inconsistent-assertion-id");
              }
              if (
                assertion &&
                (assertion.instant !== fact.recordedAt ||
                  !(yield* consistentChange(assertion, fact, "assert")))
              )
                return yield* incomplete("inconsistent-assertion");
              if (assertion && assertion.position > cut.recordedPosition) return null;
              // A positive exact-cut state read can classify an unattributed legacy assertion
              // without guessing from wall-clock order (which may roll back or tie).
              const visibleAtStart = () =>
                triples
                  .entity(fact.entityId, { ...basis, validAt: fact.validFrom })
                  .pipe(Effect.map((facts) => facts.some((f) => f.id === fact.id)));
              if (!assertion) {
                if (!(yield* visibleAtStart()))
                  return yield* incomplete("missing-assertion-position");
                gaps.push({ kind: "missing-assertion", tripleId: fact.id, txId: assertionId });
              }
              const retractionId = Option.getOrNull(fact.retractTxId);
              let retraction = retractionId ? yield* receipt(retractionId) : null;
              let retractedAt: number | null = null;
              if (!retraction && Option.isSome(fact.retractedAt)) {
                retraction =
                  (yield* journals(fact.entityId)).find((tx) =>
                    tx.changes.some((c) => c.op === "retract" && c.tripleId === fact.id),
                  ) ?? null;
                if (retraction && retractionId && retraction.txId !== retractionId)
                  return yield* incomplete("inconsistent-retraction-id");
                if (!retraction && !(yield* visibleAtStart())) {
                  if (!assertion) return yield* incomplete("missing-retraction-position");
                  if (!Number.isFinite(fact.retractedAt.value))
                    return yield* incomplete("invalid-retraction-time");
                  retractedAt = fact.retractedAt.value;
                  gaps.push({ kind: "missing-retraction", tripleId: fact.id, txId: retractionId });
                }
              }
              if (retraction && retraction.position <= cut.recordedPosition) {
                if (
                  (assertion && retraction.position < assertion.position) ||
                  retraction.instant !== Option.getOrNull(fact.retractedAt) ||
                  !retraction.changes.some(
                    (c) =>
                      c.op === "retract" && c.tripleId === fact.id && c.entityId === fact.entityId,
                  )
                )
                  return yield* incomplete("inconsistent-retraction");
                retractedAt = retraction.instant;
              } else retraction = null;
              if (assertion) {
                starts.set(assertion.txId, assertion);
                included.set(assertion.txId, assertion);
              }
              if (retraction) {
                starts.set(retraction.txId, retraction);
                included.set(retraction.txId, retraction);
              }
              const to = Option.getOrNull(fact.validTo);
              return {
                tripleId: fact.id,
                entityId: fact.entityId,
                entityType: Option.getOrNull(fact.entityType),
                attribute: fact.attribute,
                value: fact.value,
                valid: { from: fact.validFrom, to },
                recorded: { from: fact.recordedAt, to: retractedAt },
                visible:
                  retractedAt === null &&
                  fact.validFrom <= validAt &&
                  (to === null || validAt < to),
                assertion: assertion?.txId ?? null,
                retraction: retraction?.txId ?? null,
              } satisfies FactExplanation;
            });
          let selected: readonly Triple[];
          let derivation: Explanation["derivation"] = null;
          if (subject.kind === "candidate") {
            const evaluate = Derivation.evaluate(triples, subject.definition, { basis });
            // Hosts may expose only Why, keeping their policy service private.
            const evaluated = yield* Option.isSome(sensitivity)
              ? evaluate.pipe(Effect.provideService(Sensitivity, sensitivity.value))
              : evaluate;
            const candidate = evaluated.candidates.find((c) => c.id === subject.candidateId);
            if (!candidate) return yield* missing();
            if (candidate.revision !== subject.revision)
              return yield* new WhyCandidateRevisionMismatch({
                subjectId,
                reason: "revision",
                message: "Candidate revision differs at basis",
              });
            const sources: Triple[] = [];
            for (const source of candidate.sources) {
              if (source.hypothetical) return yield* invalid("hypothetical-source");
              const fact = yield* triples.assertion(source.tripleId);
              if (
                !fact ||
                fact.id !== source.tripleId ||
                fact.entityId !== source.entityId ||
                fact.attribute !== source.attribute ||
                fact.validFrom !== source.validFrom ||
                Option.getOrUndefined(fact.validTo) !== source.validTo ||
                (source.transactionId !== undefined &&
                  Option.getOrUndefined(fact.txId) !== source.transactionId)
              )
                return yield* incomplete("inconsistent-source");
              if (
                source.transactionId &&
                source.transactionPosition !== undefined &&
                (yield* receipt(source.transactionId))?.position !== source.transactionPosition
              )
                return yield* incomplete("inconsistent-source-position");
              sources.push(fact);
            }
            selected = [...new Map(sources.map((f) => [f.id, f])).values()];
            derivation = {
              name: subject.definition.name,
              candidate,
              release: yield* release(subject.definition.configSnapshot),
              evaluationNextTemporalBoundary: evaluated.nextTemporalBoundary ?? null,
            };
          } else if (subject.kind === "fact") {
            const fact = yield* triples.assertion(subject.tripleId);
            if (!fact) return yield* missing();
            if (fact.id !== subject.tripleId) return yield* incomplete("inconsistent-fact-id");
            selected = [fact];
          } else {
            selected = (yield* triples.entity(subject.entityId, basis)).filter(
              (f) => subject.kind === "entity" || f.attribute === subject.attribute,
            );
          }
          const facts: FactExplanation[] = [];
          for (const fact of selected) {
            const expanded = yield* expand(fact);
            if (expanded) facts.push(expanded);
            else if (subject.kind === "fact") return yield* missing();
            else return yield* incomplete("source-after-basis");
            if (subject.kind !== "fact" && expanded && !expanded.visible)
              return yield* incomplete("source-not-visible");
          }
          const traces: CausationTrace[] = [];
          for (const start of [...starts.values()].sort((a, b) => compare(a.txId, b.txId))) {
            const ancestors: TransactionId[] = [];
            const visited = new Set<TransactionId>([start.txId]);
            let current = start;
            let stop: CausationTrace["stop"] = { reason: "disabled" };
            if (depth > 0)
              while (true) {
                const commandId = current.causationId;
                if (commandId === undefined) {
                  stop = { reason: "root" };
                  break;
                }
                if (ancestors.length === depth) {
                  stop = { reason: "depth-limit", commandId };
                  break;
                }
                let parent: TransactionRecord | null;
                if (commands.has(commandId)) parent = commands.get(commandId)!;
                else {
                  parent = yield* triples.transactionByCommand(commandId);
                  commands.set(commandId, parent);
                }
                if (!parent) {
                  stop = { reason: "missing", commandId };
                  break;
                }
                if (
                  parent.commandId !== commandId ||
                  !Number.isSafeInteger(parent.position) ||
                  parent.position < 1 ||
                  !Number.isFinite(parent.instant)
                )
                  return yield* incomplete("inconsistent-parent");
                const previous = receipts.get(parent.txId) ?? included.get(parent.txId);
                if (
                  previous &&
                  (previous.position !== parent.position ||
                    previous.instant !== parent.instant ||
                    previous.commandId !== parent.commandId ||
                    previous.causationId !== parent.causationId ||
                    previous.actor !== parent.actor ||
                    previous.configSnapshot !== parent.configSnapshot ||
                    previous.correlationId !== parent.correlationId)
                )
                  return yield* incomplete("inconsistent-immutable-receipt");
                receipts.set(parent.txId, parent);
                if (parent.position > cut.recordedPosition) {
                  stop = { reason: "after-basis", commandId };
                  break;
                }
                if (visited.has(parent.txId)) {
                  stop = { reason: "cycle", commandId, txId: parent.txId };
                  break;
                }
                ancestors.push(parent.txId);
                visited.add(parent.txId);
                included.set(parent.txId, parent);
                current = parent;
              }
            traces.push({ start: start.txId, ancestors, stop });
          }
          const transactions: TransactionExplanation[] = [];
          for (const tx of [...included.values()].sort(
            (a, b) => a.position - b.position || compare(a.txId, b.txId),
          ))
            transactions.push({
              txId: tx.txId,
              position: tx.position,
              instant: tx.instant,
              actor: tx.actor ?? null,
              commandId: tx.commandId ?? null,
              correlationId: tx.correlationId ?? null,
              causationId: tx.causationId ?? null,
              release: yield* release(tx.configSnapshot),
            });
          facts.sort(
            (a, b) =>
              compare(a.entityId, b.entityId) ||
              compare(a.attribute, b.attribute) ||
              compare(a.tripleId, b.tripleId),
          );
          gaps.sort((a, b) => compare(a.tripleId, b.tripleId) || compare(a.kind, b.kind));
          return {
            version: 1,
            subject:
              subject.kind === "candidate"
                ? {
                    kind: "candidate",
                    candidateId: subject.candidateId,
                    revision: subject.revision,
                  }
                : subject.kind === "fact"
                  ? { kind: "fact", tripleId: subject.tripleId }
                  : subject.kind === "attribute"
                    ? {
                        kind: "attribute",
                        entityId: subject.entityId,
                        attribute: subject.attribute,
                      }
                    : { kind: "entity", entityId: subject.entityId },
            basis,
            facts,
            transactions,
            derivation,
            causation: { maxDepth: depth, traces },
            gaps,
          };
        });
      return { why };
    }),
  );
}
