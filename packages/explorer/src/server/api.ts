import { randomUUID } from "node:crypto";

import {
  Change as FactChange,
  EntityId,
  TransactionId,
  TripleId,
  Triples,
  ref,
  type TransactOp,
  type TransactionPrecondition,
  type TransactionRecord,
  type Triple,
  type TripleValue,
} from "@triplex-internal/core";
import { ConfigStore, ContentId, GraphConstraint } from "@triplex-internal/core/config";
import type { WrappedQuery } from "@triplex-internal/core/datalog";

type Clause = WrappedQuery["inner"]["where"][number];
import { Why } from "@triplex-internal/core/why";
import { Context, Effect, Layer, Option, Stream } from "effect";

import type {
  Basis,
  Description,
  EntityRecord,
  ExplorerRequest,
  Fact,
  JournalPage,
  LiveEvent,
  References,
  ResolvedBasis,
  Row,
  RowsPage,
  Saved,
  Transaction,
  TypeView,
  Value,
} from "../shared/protocol.js";
import { describeTypes } from "./describe.js";

const valueView = (value: TripleValue): Value => {
  switch (value.type) {
    case "blob":
      return { type: "blob", value: value.value, mimeType: value.mimeType };
    case "sealed":
      // The explorer has no key access; sealed values stay sealed.
      return { type: "sealed", valueType: value.valueType };
    default:
      return value as Value;
  }
};

const factView = (triple: Triple): Fact => ({
  id: triple.id,
  entityId: triple.entityId,
  attribute: triple.attribute,
  value: valueView(triple.value),
  validFrom: triple.validFrom,
  validTo: Option.getOrNull(triple.validTo),
  recordedAt: triple.recordedAt,
  retractedAt: Option.getOrNull(triple.retractedAt),
  txId: Option.getOrNull(triple.txId),
  retractTxId: Option.getOrNull(triple.retractTxId),
});

const isApplicationEntity = (id: string) => !id.startsWith("_triplex/") && !id.startsWith("_tx/");

/** Presentation only: a name, title or label attribute, then any text, then the ID. */
const labelOf = (id: string, facts: readonly Triple[]): string => {
  const texts = facts
    .flatMap((fact) =>
      fact.value.type === "string" ? [{ attribute: fact.attribute, text: fact.value.value }] : [],
    )
    .sort((a, b) => a.attribute.localeCompare(b.attribute));
  const preferred = texts.find((fact) => /\/(name|title|label)$/.test(fact.attribute)) ?? texts[0];
  return preferred === undefined ? id : preferred.text;
};

const refTargets = (facts: readonly Triple[]): string[] => [
  ...new Set(facts.flatMap((fact) => (fact.value.type === "ref" ? [fact.value.value] : []))),
];

export interface ExplorerService {
  readonly handle: (request: ExplorerRequest) => Effect.Effect<unknown, unknown>;
  /** Journal events strictly after `after`, preceded by the current head. */
  readonly live: (after: number | undefined) => Stream.Stream<LiveEvent>;
}

export class Explorer extends Context.Service<Explorer, ExplorerService>()(
  "triplex-explorer/Explorer",
) {
  static layer = (options: {
    readonly database: string;
    readonly readOnly: boolean;
  }): Layer.Layer<Explorer, never, Triples | ConfigStore.ConfigStore | Why> =>
    Layer.effect(
      Explorer,
      Effect.gen(function* () {
        const triples = yield* Triples;
        const config = yield* ConfigStore.ConfigStore;
        const whyService = yield* Why;
        const releaseLabels = new Map<string, string | null>();

        const releaseOf = (id: string | undefined) =>
          Effect.gen(function* () {
            if (id === undefined) return null;
            if (!releaseLabels.has(id)) {
              const snapshot = ContentId.isContentId(id)
                ? yield* config.snapshotById(id).pipe(Effect.orElseSucceed(() => undefined))
                : undefined;
              releaseLabels.set(id, snapshot?.label ?? null);
            }
            return { id, label: releaseLabels.get(id) ?? null };
          });

        const transactionView = (record: TransactionRecord) =>
          Effect.map(
            releaseOf(record.configSnapshot),
            (release): Transaction => ({
              txId: record.txId,
              position: record.position,
              instant: record.instant,
              actor: record.actor ?? null,
              commandId: record.commandId ?? null,
              correlationId: record.correlationId ?? null,
              causationId: record.causationId ?? null,
              release,
              changes: record.changes.map((change) => ({
                op: change.op,
                tripleId: change.tripleId,
                entityId: change.entityId,
                entityType: change.entityType ?? null,
                attribute: change.attribute,
                value: change.value === undefined ? null : valueView(change.value),
                validFrom: change.validFrom ?? null,
                validTo: change.validTo ?? null,
              })),
            }),
          );

        const resolve = (basis: Basis) =>
          Effect.map(
            triples.resolveRecordedBasis(
              basis.recordedPosition === undefined
                ? {}
                : { recordedPosition: basis.recordedPosition },
            ),
            ({ recordedPosition }): ResolvedBasis => ({
              recordedPosition,
              validAt: basis.validAt ?? Date.now(),
            }),
          );

        const labelsFor = (ids: readonly string[], basis: ResolvedBasis) =>
          ids.length === 0
            ? Effect.succeed({} as Record<string, string>)
            : Effect.map(
                triples.entities(
                  ids.map((id) => EntityId.make(id)),
                  basis,
                ),
                (bodies) =>
                  Object.fromEntries(
                    ids.map((id, index) => [id, labelOf(id, bodies[index] ?? [])]),
                  ),
              );

        const types = Effect.gen(function* () {
          const snapshot = yield* config.resolveRef("live");
          return snapshot === undefined
            ? { snapshot: undefined, types: [] as readonly TypeView[] }
            : { snapshot, types: yield* describeTypes(snapshot) };
        });

        const describe = Effect.gen(function* () {
          const [head, described] = yield* Effect.all([triples.currentPosition(), types]);
          return {
            database: options.database,
            head,
            readOnly: options.readOnly,
            release:
              described.snapshot === undefined
                ? null
                : {
                    id: described.snapshot.id,
                    label: described.snapshot.label,
                    rootContentId: described.snapshot.rootCid,
                  },
            types: described.types,
          } satisfies Description;
        });

        const rows = (request: Extract<ExplorerRequest, { _tag: "Rows" }>) =>
          Effect.gen(function* () {
            const started = performance.now();
            const type = (yield* types).types.find((t) => t.name === request.entityType);
            if (type === undefined)
              return yield* Effect.fail(new Error(`Unknown entity type ${request.entityType}`));
            const limit = Math.min(Math.max(1, Math.trunc(request.limit)), 200);
            const basis = yield* resolve(request.basis);
            const anchorCount =
              request.cursor !== undefined || type.anchor === null
                ? Effect.succeed<number | null>(null)
                : Effect.map(
                    triples.queryPage(
                      {
                        inner: { find: ["?e"], where: [["?e", type.anchor, "?anchor"]] },
                        limit: 1,
                        includeCount: true,
                      },
                      { basis },
                    ),
                    (page) => page.totalCount ?? null,
                  );

            let entities: (readonly Triple[])[];
            let nextCursor: string | null;
            let totalCount: number | null;
            let source: RowsPage["source"];
            if (request.sort === undefined && request.filters.length === 0) {
              // The exact type, ordered by entity ID, from one commit cut.
              const page = yield* triples.entityPage({
                entityType: type.name,
                limit,
                basis,
                ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
              });
              entities = [...page.entities];
              nextCursor = page.nextCursor ?? null;
              totalCount = yield* anchorCount;
              source = "entities";
            } else {
              // Joins, not optional projections: SQLite evaluates optional projections as
              // per-row subqueries and sorts on them, which is seconds slower on a few
              // thousand rows. Rows with the sorted value page first; rows without it
              // page second, so blank cells still sort last.
              const sortKey = request.sort?.attribute;
              const valueFilters = request.filters.filter((filter) => filter.op !== "empty");
              const absent: Clause[] = request.filters
                .filter((filter) => filter.op === "empty")
                .map((filter, index) => ["not", ["?e", filter.attribute, `?absent${index}`]]);
              const others = [...new Set(valueFilters.map((filter) => filter.attribute))].filter(
                (key) => key !== sortKey,
              );
              const variable = new Map(
                [...(sortKey === undefined ? [] : [sortKey]), ...others].map((key, index) => [
                  key,
                  `?c${index}`,
                ]),
              );
              const base: Clause[] = [
                ...(type.anchor === null ? [] : [["?e", type.anchor, "?anchor"] as Clause]),
                ...others.map((key) => ["?e", key, variable.get(key)!] as Clause),
              ];
              const filters = valueFilters.map((filter) => {
                const column = variable.get(filter.attribute)!;
                switch (filter.op) {
                  case "contains":
                    return {
                      column,
                      op: "ilike" as const,
                      value: `%${String(filter.value ?? "")}%`,
                    };
                  case "not-empty":
                    return { column, op: "is-not-null" as const };
                  default:
                    return { column, op: filter.op as "=", value: filter.value ?? "" };
                }
              });
              const phase = (blank: boolean): WrappedQuery | null => {
                const keys = blank ? others : [...variable.keys()];
                const where: Clause[] = [
                  ...base,
                  ...(sortKey === undefined || blank
                    ? []
                    : [["?e", sortKey, variable.get(sortKey)!] as Clause]),
                  ...(blank && sortKey !== undefined
                    ? [["not", ["?e", sortKey, "?blank"]] as Clause]
                    : []),
                  ...absent,
                ];
                // Negation needs ?e bound by a positive pattern first.
                if (!where.some((clause) => Array.isArray(clause) && clause[0] === "?e"))
                  return null;
                return {
                  inner: { find: ["?e", ...keys.map((key) => variable.get(key)!)], where },
                  filters: blank
                    ? filters.filter((filter) => filter.column !== variable.get(sortKey ?? ""))
                    : filters,
                  orderBy:
                    sortKey === undefined || blank
                      ? [{ variable: "?e", direction: "asc" }]
                      : [{ variable: variable.get(sortKey)!, direction: request.sort!.direction }],
                  limit,
                };
              };
              const values = phase(false);
              // Rows without the sorted value exist only when the sort is on an optional column.
              const blanks =
                sortKey === undefined ||
                type.attributes.some(
                  (attribute) => attribute.key === sortKey && attribute.required,
                ) ||
                valueFilters.some((filter) => filter.attribute === sortKey)
                  ? null
                  : phase(true);
              if (values === null)
                return yield* Effect.fail(
                  new Error(
                    `${type.name} has no attribute every entity carries, so filter on a value instead`,
                  ),
                );
              const position =
                request.cursor === undefined
                  ? { blank: false }
                  : (JSON.parse(request.cursor) as { blank: boolean; cursor?: string });
              const first = request.cursor === undefined;
              const query = position.blank ? blanks! : values;
              const page = yield* triples.queryPage(
                // A cursor belongs to its exact query, so each pass sends the same one on every page.
                {
                  ...query,
                  includeCount: !position.blank,
                  ...(position.cursor === undefined ? {} : { cursor: position.cursor }),
                },
                { basis },
              );
              // Without filters, blanks are the type's members minus those with a value,
              // which two indexed counts answer faster than counting a negation.
              const blankCount =
                !first || blanks === null
                  ? 0
                  : request.filters.length === 0 && type.anchor !== null
                    ? Math.max(0, ((yield* anchorCount) ?? 0) - (page.totalCount ?? 0))
                    : ((yield* triples.queryPage(
                        { ...blanks, limit: 1, includeCount: true },
                        { basis },
                      )).totalCount ?? 0);
              // A many-valued sort or filter column can repeat an entity; keep its first row.
              const ids = [...new Set(page.results.map((result) => String(result["?e"])))];
              entities = [
                ...(yield* triples.entities(
                  ids.map((id) => EntityId.make(id)),
                  basis,
                )),
              ];
              nextCursor =
                page.nextCursor !== undefined
                  ? JSON.stringify({ blank: position.blank, cursor: page.nextCursor })
                  : !position.blank && blanks !== null && (first ? blankCount > 0 : true)
                    ? JSON.stringify({ blank: true })
                    : null;
              totalCount = first ? (page.totalCount ?? 0) + blankCount : null;
              source = "query";
            }
            const rowsView: Row[] = entities
              .filter((facts) => facts.length > 0)
              .map((facts) => ({ id: facts[0]!.entityId, facts: facts.map(factView) }));
            const labels = yield* labelsFor(refTargets(entities.flat()), basis);
            return {
              entityType: type.name,
              basis,
              rows: rowsView,
              nextCursor,
              totalCount,
              source,
              anchor: type.anchor,
              labels,
              durationMs: Math.round((performance.now() - started) * 10) / 10,
            } satisfies RowsPage;
          });

        const entityRecord = (entityId: string, requested: Basis) =>
          Effect.gen(function* () {
            const id = EntityId.make(entityId);
            const basis = yield* resolve(requested);
            const [facts, history, page] = yield* Effect.all([
              triples.entity(id, basis),
              triples.history(id),
              triples.transactionsForEntity(id, { limit: 50 }),
            ]);
            const transactions = yield* Effect.forEach(page.transactions, transactionView);
            const typed = history.find((fact) => Option.isSome(fact.entityType));
            return {
              entityId,
              entityType: typed === undefined ? null : Option.getOrNull(typed.entityType),
              basis,
              facts: facts.map(factView),
              history: [...history]
                .sort((a, b) => a.recordedAt - b.recordedAt || a.validFrom - b.validFrom)
                .map(factView),
              transactions,
              moreTransactions: page.nextBeforePosition !== undefined,
              labels: yield* labelsFor(refTargets(history), basis),
              label: labelOf(entityId, facts.length > 0 ? facts : history),
            } satisfies EntityRecord;
          });

        const references = (entityId: string, requested: Basis) =>
          Effect.gen(function* () {
            const basis = yield* resolve(requested);
            const page = yield* triples.queryPage(
              {
                inner: {
                  find: ["?source", "?attribute"],
                  where: [["?source", "?attribute", ref(EntityId.make(entityId))]],
                },
                orderBy: [{ variable: "?attribute" }, { variable: "?source" }],
                limit: 200,
                includeCount: true,
              },
              { basis },
            );
            const found = page.results
              .map((result) => ({
                source: String(result["?source"]),
                attribute: String(result["?attribute"]),
              }))
              .filter((found) => isApplicationEntity(found.source));
            const sources = [...new Set(found.map((found) => found.source))];
            const bodies = yield* triples.entities(
              sources.map((id) => EntityId.make(id)),
              basis,
            );
            const byId = new Map(sources.map((id, index) => [id, bodies[index] ?? []]));
            return {
              entityId,
              references: found.map((found) => {
                const body = byId.get(found.source) ?? [];
                const typed = body.find((fact) => Option.isSome(fact.entityType));
                return {
                  ...found,
                  sourceType: typed === undefined ? null : Option.getOrNull(typed.entityType),
                  label: labelOf(found.source, body),
                };
              }),
              total: page.totalCount ?? null,
              truncated: page.nextCursor !== undefined,
            } satisfies References;
          });

        const journal = (before: number | undefined, requestedLimit: number) =>
          Effect.gen(function* () {
            const head = yield* triples.currentPosition();
            const limit = Math.min(Math.max(1, Math.trunc(requestedLimit)), 200);
            const end = before ?? head + 1;
            const after = Math.max(0, end - 1 - limit);
            const page = yield* triples.transactions({ after, limit });
            const records = page.transactions.filter((record) => record.position < end).reverse();
            return {
              head,
              transactions: yield* Effect.forEach(records, transactionView),
              nextBefore: after > 0 ? after + 1 : null,
            } satisfies JournalPage;
          });

        const save = (request: Extract<ExplorerRequest, { _tag: "Save" }>) =>
          Effect.gen(function* () {
            if (options.readOnly)
              return yield* Effect.fail(new Error("This database is open read-only"));
            const snapshot = yield* config.resolveRef("live");
            if (snapshot === undefined)
              return yield* Effect.fail(new Error("Publish a release to the live ref first"));
            const pin = yield* GraphConstraint.pinned(snapshot);
            const id = EntityId.make(request.entityId.trim());
            if (request.mode === "create" && (yield* triples.liveFacts(id)).length > 0)
              return yield* Effect.fail(new Error(`${id} already exists`));
            const current = request.mode === "edit" ? yield* triples.entity(id) : [];
            const at = request.effectiveFrom;
            const ops: TransactOp[] = [];
            const preconditions: TransactionPrecondition[] = [];
            const same = (a: TripleValue, b: TripleValue) =>
              a.type === b.type && "value" in a && "value" in b && a.value === b.value;
            const assert = (attribute: string, value: TripleValue, validFrom?: number) => {
              ops.push({
                op: "assert",
                entityId: id,
                entityType: request.entityType,
                attribute,
                value,
                ...(validFrom === undefined ? {} : { validFrom }),
              });
            };
            for (const { attribute, values: wire } of request.values) {
              const values = wire.map((value) =>
                value.type === "ref" ? ref(EntityId.make(value.value)) : (value as TripleValue),
              );
              const existing = current.filter((fact) => fact.attribute === attribute);
              const unchanged =
                existing.length === values.length &&
                values.every((value) => existing.some((fact) => same(fact.value, value)));
              if (unchanged) continue;
              if (request.change === "correct") {
                // Rewrite each value over its original interval; recorded history keeps the old one.
                existing.forEach((fact, index) => {
                  const value = values[index];
                  const change =
                    value === undefined
                      ? {
                          ops: [{ op: "retract" as const, id: fact.id }],
                          preconditions: [{ _tag: "TripleLive" as const, id: fact.id }],
                        }
                      : FactChange.correct(fact, value);
                  ops.push(...change.ops);
                  preconditions.push(...change.preconditions);
                });
                for (const value of values.slice(existing.length))
                  assert(attribute, value, existing[0]?.validFrom ?? at);
              } else {
                const from = at ?? Date.now();
                for (const fact of existing) {
                  const ended =
                    from > fact.validFrom
                      ? FactChange.end(fact, from)
                      : {
                          ops: [{ op: "retract" as const, id: fact.id }],
                          preconditions: [{ _tag: "TripleLive" as const, id: fact.id }],
                        };
                  ops.push(...ended.ops);
                  preconditions.push(...ended.preconditions);
                }
                for (const value of values) assert(attribute, value, from);
              }
            }
            if (ops.length === 0) return yield* Effect.fail(new Error("Nothing changed"));
            const result = yield* triples.transact(ops, {
              actor: request.actor,
              commandId: `explorer:${randomUUID()}`,
              ...pin,
              preconditions,
            });
            return { txId: result.txId, position: result.position } satisfies Saved;
          });

        const handle: ExplorerService["handle"] = (request) => {
          switch (request._tag) {
            case "Describe":
              return describe;
            case "Rows":
              return rows(request);
            case "Record":
              return entityRecord(request.entityId, request.basis);
            case "References":
              return references(request.entityId, request.basis);
            case "Why":
              return Effect.gen(function* () {
                const basis = yield* resolve(request.basis);
                const subject = request.subject;
                return yield* whyService.why(
                  subject.kind === "fact"
                    ? { kind: "fact", tripleId: TripleId.make(subject.tripleId) }
                    : subject.kind === "attribute"
                      ? {
                          kind: "attribute",
                          entityId: EntityId.make(subject.entityId),
                          attribute: subject.attribute,
                        }
                      : { kind: "entity", entityId: EntityId.make(subject.entityId) },
                  { basis, causationDepth: 8 },
                );
              });
            case "Journal":
              return journal(request.before, request.limit);
            case "Transaction":
              return Effect.gen(function* () {
                const record = yield* triples.transaction(TransactionId.make(request.txId));
                return record === null ? null : yield* transactionView(record);
              });
            case "Save":
              return save(request);
          }
        };

        const head = Effect.gen(function* () {
          const [position, dependency] = yield* Effect.all([
            triples.currentPosition(),
            triples.dependencyStateAll(),
          ]);
          return {
            type: "head",
            position,
            nextTemporalBoundary: dependency.nextTemporalBoundary ?? null,
          } satisfies LiveEvent;
        });

        // The ordered journal is authoritative, so polling it also sees other processes' commits.
        const live: ExplorerService["live"] = (after) =>
          Stream.paginate({ after, first: true }, (state) =>
            Effect.gen(function* () {
              if (!state.first) yield* Effect.sleep("400 millis");
              const current = yield* head;
              const from = state.after ?? current.position;
              if (current.position <= from)
                return [
                  state.first ? [current] : [],
                  Option.some({ after: from, first: false }),
                ] as const;
              const page = yield* triples.transactions({ after: from, limit: 100 });
              const events: LiveEvent[] = [];
              for (const record of page.transactions)
                events.push({ type: "tx", transaction: yield* transactionView(record) });
              return [
                [...events, current],
                Option.some({ after: page.next ?? current.position, first: false }),
              ] as const;
            }).pipe(
              Effect.catch((error) =>
                Effect.succeed([
                  [{ type: "error", message: String(error) } satisfies LiveEvent],
                  Option.none(),
                ] as const),
              ),
            ),
          );

        return Explorer.of({ handle, live });
      }),
    );
}
