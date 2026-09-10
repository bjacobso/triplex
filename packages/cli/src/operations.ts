import {
  type DatalogQuery as DatalogQueryType,
  DatabaseManager,
  type EntityId,
  Triples,
  type Pattern,
  type TemporalBasis,
  type TransactionId,
  type TransactRequest,
  type Triple,
  type WrappedQuery as WrappedQueryType,
} from "@bjacobso/triplex";
import { ConfigStore, InMemoryConfigStore } from "@bjacobso/triplex/config";
import type { ContentId } from "@bjacobso/triplex/content";
import { Effect, Option } from "effect";

export type ExecuteOptions =
  | { readonly _tag: "status" }
  | { readonly _tag: "entity-types"; readonly includeSystem: boolean }
  | {
      readonly _tag: "entity-list";
      readonly entityType?: string | undefined;
      readonly limit: number;
      readonly after?: string | undefined;
      readonly includeSystem: boolean;
      readonly basis?: TemporalBasis | undefined;
    }
  | {
      readonly _tag: "entity-get";
      readonly entityId: EntityId;
      readonly basis?: TemporalBasis | undefined;
    }
  | { readonly _tag: "entity-facts"; readonly entityId: EntityId }
  | {
      readonly _tag: "entity-history";
      readonly entityId: EntityId;
      readonly limit: number;
      readonly snapshotPosition?: number | undefined;
      readonly beforePosition?: number | undefined;
    }
  | {
      readonly _tag: "fact-match";
      readonly pattern: Pattern;
      readonly basis?: TemporalBasis | undefined;
    }
  | {
      readonly _tag: "query-run";
      readonly cursor?: string;
      readonly pageSize?: number;
      readonly query: DatalogQueryType;
      readonly basis?: TemporalBasis | undefined;
      readonly debug: boolean;
    }
  | {
      readonly _tag: "query-page";
      readonly query: WrappedQueryType;
      readonly basis?: TemporalBasis | undefined;
      readonly debug: boolean;
    }
  | { readonly _tag: "query-explain"; readonly query: DatalogQueryType }
  | { readonly _tag: "transaction-apply"; readonly request: TransactRequest }
  | { readonly _tag: "journal-list"; readonly after: number; readonly limit: number }
  | { readonly _tag: "journal-receipt"; readonly commandId: string }
  | { readonly _tag: "journal-transaction"; readonly transactionId: TransactionId }
  | { readonly _tag: "config-refs" }
  | { readonly _tag: "config-releases" }
  | {
      readonly _tag: "config-release";
      readonly snapshotId?: ContentId.ContentId | undefined;
      readonly ref?: string | undefined;
    }
  | {
      readonly _tag: "config-objects";
      readonly kind?: string | undefined;
      readonly activeOnly: boolean;
    }
  | { readonly _tag: "config-object"; readonly kind: string; readonly key: string }
  | {
      readonly _tag: "config-set-ref";
      readonly name: string;
      readonly snapshotId: InMemoryConfigStore.ConfigSnapshot["id"];
    }
  | { readonly _tag: "config-impact"; readonly kind: string; readonly key: string };

export type ExecuteDatabaseOptions =
  | {
      readonly _tag: "database-create";
      readonly name: string;
      readonly description?: string | undefined;
    }
  | { readonly _tag: "database-list" }
  | { readonly _tag: "database-get"; readonly name: string }
  | { readonly _tag: "database-update"; readonly name: string; readonly description: string }
  | { readonly _tag: "database-clear"; readonly name: string }
  | { readonly _tag: "database-delete"; readonly name: string };

const isSystemEntity = (entityId: string): boolean =>
  entityId.startsWith("_triplex/") || entityId.startsWith("_tx/");

const tripleView = (triple: Triple) => ({
  id: triple.id,
  entityId: triple.entityId,
  entityType: Option.getOrNull(triple.entityType),
  attribute: triple.attribute,
  value: triple.value,
  validFrom: triple.validFrom,
  validTo: Option.getOrNull(triple.validTo),
  recordedAt: triple.recordedAt,
  retractedAt: Option.getOrNull(triple.retractedAt),
  createdBy: Option.getOrNull(triple.createdBy),
  transactionId: Option.getOrNull(triple.txId),
  retractionTransactionId: Option.getOrNull(triple.retractTxId),
});

const entityView = (entityId: string, facts: readonly Triple[]) => ({
  entityId,
  entityType: Option.getOrNull(facts[0]?.entityType ?? Option.none()),
  facts: facts.map(tripleView),
});

const snapshotView = (snapshot: InMemoryConfigStore.ConfigSnapshot, refs: readonly string[]) => ({
  snapshotId: snapshot.id,
  sequence: snapshot.seq,
  label: snapshot.label,
  rootContentId: snapshot.rootCid,
  parentSnapshotId: snapshot.parentId,
  revisionIds: snapshot.revisionIds,
  refs,
});

const revisionView = (
  store: InMemoryConfigStore.InMemoryConfigStore,
  revision: InMemoryConfigStore.Revision,
) => ({
  revisionId: revision.id,
  sequence: revision.seq,
  kind: revision.kind,
  key: revision.key,
  contentId: revision.cid,
  closureContentId: revision.closureCid,
  schemaContentIds: revision.schemaCids,
  stamp: revision.stamp,
  parentRevisionId: revision.parentId,
  dependencies: revision.deps,
  body: store.objects.get(revision.cid)?.body ?? null,
  releases: store.snapshots
    .filter((snapshot) => snapshot.revisionIds.includes(revision.id))
    .map((snapshot) => ({ snapshotId: snapshot.id, label: snapshot.label })),
});

const refsFor = (
  store: InMemoryConfigStore.InMemoryConfigStore,
  snapshotId: string,
): readonly string[] =>
  [...store.refs.entries()]
    .filter(([, candidate]) => candidate === snapshotId)
    .map(([name]) => name)
    .sort();

const validatePageSize = (limit: number): Effect.Effect<number, Error> =>
  Number.isInteger(limit) && limit >= 1 && limit <= 1_000
    ? Effect.succeed(limit)
    : Effect.fail(new Error("limit must be an integer between 1 and 1000"));

export const execute = (
  options: ExecuteOptions,
): Effect.Effect<unknown, unknown, Triples | ConfigStore.ConfigStore> =>
  Effect.gen(function* () {
    const triples = yield* Triples;

    switch (options._tag) {
      case "status": {
        const config = yield* ConfigStore.ConfigStore;
        const [position, store] = yield* Effect.all([triples.currentPosition(), config.load()]);
        return {
          position,
          config: {
            objects: store.objects.size,
            revisions: store.revisions.length,
            releases: store.snapshots.length,
            refs: store.refs.size,
          },
        };
      }
      case "entity-types": {
        const facts = yield* triples.match({});
        const grouped = new Map<string, { entities: Set<string>; attributes: Set<string> }>();
        for (const fact of facts) {
          if (!options.includeSystem && isSystemEntity(fact.entityId)) continue;
          const entityType = Option.getOrNull(fact.entityType) ?? "Entity";
          const summary = grouped.get(entityType) ?? {
            entities: new Set<string>(),
            attributes: new Set<string>(),
          };
          summary.entities.add(fact.entityId);
          summary.attributes.add(fact.attribute);
          grouped.set(entityType, summary);
        }
        return {
          entityTypes: [...grouped.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([entityType, summary]) => ({
              entityType,
              entityCount: summary.entities.size,
              attributes: [...summary.attributes].sort(),
            })),
        };
      }
      case "entity-list": {
        const limit = yield* validatePageSize(options.limit);
        const facts = yield* triples.match(
          options.entityType === undefined ? {} : { entityType: options.entityType },
          options.basis,
        );
        const grouped = new Map<string, Triple[]>();
        for (const fact of facts) {
          if (!options.includeSystem && isSystemEntity(fact.entityId)) continue;
          if (options.after !== undefined && fact.entityId <= options.after) continue;
          const current = grouped.get(fact.entityId) ?? [];
          current.push(fact);
          grouped.set(fact.entityId, current);
        }
        const ids = [...grouped.keys()].sort().slice(0, limit + 1);
        const hasMore = ids.length > limit;
        const pageIds = ids.slice(0, limit);
        return {
          entities: pageIds.map((id) => entityView(id, grouped.get(id) ?? [])),
          nextAfter: hasMore ? pageIds.at(-1) : undefined,
        };
      }
      case "entity-get": {
        const facts = yield* triples.entity(options.entityId, options.basis);
        return entityView(options.entityId, facts);
      }
      case "entity-facts": {
        const facts = yield* triples.history(options.entityId);
        return { entityId: options.entityId, facts: facts.map(tripleView) };
      }
      case "entity-history": {
        const limit = yield* validatePageSize(options.limit);
        return yield* triples.transactionsForEntity(options.entityId, {
          limit,
          ...(options.snapshotPosition === undefined
            ? {}
            : { snapshotPosition: options.snapshotPosition }),
          ...(options.beforePosition === undefined
            ? {}
            : { beforePosition: options.beforePosition }),
        });
      }
      case "fact-match": {
        const facts = yield* triples.match(options.pattern, options.basis);
        return { facts: facts.map(tripleView) };
      }
      case "query-run":
        return yield* triples.query(options.query, {
          ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
          debug: options.debug,
          ...(options.basis === undefined ? {} : { basis: options.basis }),
        });
      case "query-page":
        return yield* triples.queryPage(options.query, {
          debug: options.debug,
          ...(options.basis === undefined ? {} : { basis: options.basis }),
        });
      case "query-explain":
        return yield* triples.explain(options.query);
      case "transaction-apply":
        return yield* triples
          .transact(
            options.request.operations,
            options.request.meta === undefined
              ? undefined
              : {
                  ...(options.request.meta.actor === undefined
                    ? {}
                    : { actor: options.request.meta.actor }),
                  ...(options.request.meta.commandId === undefined
                    ? {}
                    : { commandId: options.request.meta.commandId }),
                  ...(options.request.meta.correlationId === undefined
                    ? {}
                    : { correlationId: options.request.meta.correlationId }),
                  ...(options.request.meta.causationId === undefined
                    ? {}
                    : { causationId: options.request.meta.causationId }),
                  ...(options.request.meta.configSnapshot === undefined
                    ? {}
                    : { configSnapshot: options.request.meta.configSnapshot }),
                  ...(options.request.meta.enforce === undefined
                    ? {}
                    : { enforce: options.request.meta.enforce }),
                  ...(options.request.meta.preconditions === undefined
                    ? {}
                    : { preconditions: options.request.meta.preconditions }),
                },
          )
          .pipe(
            Effect.map((transaction) => ({
              transactionId: transaction.txId,
              position: transaction.position,
              instant: transaction.instant,
              asserted: transaction.triples.map(tripleView),
              retracted: transaction.retracted,
            })),
          );
      case "journal-list": {
        const limit = yield* validatePageSize(options.limit);
        return yield* triples.transactions({ after: options.after, limit });
      }
      case "journal-receipt":
        return { transaction: yield* triples.transactionByCommand(options.commandId) };
      case "journal-transaction":
        return { transaction: yield* triples.transaction(options.transactionId) };
      case "config-refs": {
        const config = yield* ConfigStore.ConfigStore;
        const store = yield* config.load();
        return {
          refs: refsFromConfig(store),
        };
      }
      case "config-releases": {
        const config = yield* ConfigStore.ConfigStore;
        const store = yield* config.load();
        return {
          releases: [...store.snapshots]
            .sort((left, right) => right.seq - left.seq || right.id.localeCompare(left.id))
            .map((snapshot) => snapshotView(snapshot, refsFor(store, snapshot.id))),
        };
      }
      case "config-release": {
        const config = yield* ConfigStore.ConfigStore;
        const store = yield* config.load();
        const targetId =
          options.ref === undefined ? options.snapshotId : store.refs.get(options.ref);
        const snapshot = store.snapshots.find((candidate) => candidate.id === targetId);
        return snapshot === undefined
          ? { release: null }
          : {
              release: snapshotView(snapshot, refsFor(store, snapshot.id)),
              revisions: snapshot.revisionIds.flatMap((id) => {
                const revision = store.revisions.find((candidate) => candidate.id === id);
                return revision === undefined ? [] : [revisionView(store, revision)];
              }),
            };
      }
      case "config-objects": {
        const config = yield* ConfigStore.ConfigStore;
        const store = yield* config.load();
        const activeIds = new Set(
          [...store.refs.values()].flatMap(
            (snapshotId) =>
              store.snapshots.find((snapshot) => snapshot.id === snapshotId)?.revisionIds ?? [],
          ),
        );
        const grouped = new Map<string, InMemoryConfigStore.Revision[]>();
        for (const revision of store.revisions) {
          if (options.kind !== undefined && revision.kind !== options.kind) continue;
          const identity = `${revision.kind}\u0000${revision.key}`;
          const history = grouped.get(identity) ?? [];
          history.push(revision);
          grouped.set(identity, history);
        }
        return {
          objects: [...grouped.values()]
            .map((history) => {
              const sorted = history.sort(
                (left, right) => right.seq - left.seq || right.id.localeCompare(left.id),
              );
              const latest = sorted[0]!;
              return {
                kind: latest.kind,
                key: latest.key,
                versions: sorted.length,
                latestRevisionId: latest.id,
                active: sorted.some((revision) => activeIds.has(revision.id)),
              };
            })
            .filter((object) => !options.activeOnly || object.active)
            .sort(
              (left, right) =>
                left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key),
            ),
        };
      }
      case "config-object": {
        const config = yield* ConfigStore.ConfigStore;
        const store = yield* config.load();
        const history = store.revisions
          .filter((revision) => revision.kind === options.kind && revision.key === options.key)
          .sort((left, right) => right.seq - left.seq || right.id.localeCompare(left.id));
        return {
          object:
            history.length === 0
              ? null
              : {
                  kind: options.kind,
                  key: options.key,
                  history: history.map((revision) => revisionView(store, revision)),
                },
        };
      }
      case "config-set-ref": {
        const config = yield* ConfigStore.ConfigStore;
        const snapshot = yield* config.setRef(options.name, options.snapshotId);
        return { release: snapshotView(snapshot, [options.name]) };
      }
      case "config-impact": {
        const config = yield* ConfigStore.ConfigStore;
        const [reverseDependencies, impactCandidates] = yield* Effect.all([
          config.reverseDependencies({ kind: options.kind, key: options.key }),
          config.impactCandidates({ kind: options.kind, key: options.key }),
        ]);
        const store = yield* config.load();
        return {
          reverseDependencies: reverseDependencies.map((revision) => revisionView(store, revision)),
          impactCandidates: impactCandidates.map((revision) => revisionView(store, revision)),
        };
      }
    }
  });

export const executeDatabase = (
  options: ExecuteDatabaseOptions,
): Effect.Effect<unknown, unknown, DatabaseManager> =>
  Effect.gen(function* () {
    const manager = yield* DatabaseManager;

    switch (options._tag) {
      case "database-create":
        return {
          database: yield* manager.create(options.name, options.description),
        };
      case "database-list":
        return { databases: yield* manager.list() };
      case "database-get":
        return { database: yield* manager.get(options.name) };
      case "database-update":
        return {
          database: yield* manager.update(options.name, { description: options.description }),
        };
      case "database-clear":
        return yield* manager.clear(options.name);
      case "database-delete":
        yield* manager.delete(options.name);
        return { database: options.name, deleted: true };
    }
  });

const refsFromConfig = (
  store: InMemoryConfigStore.InMemoryConfigStore,
): readonly {
  readonly name: string;
  readonly snapshotId: string;
  readonly label: string | null;
}[] =>
  [...store.refs.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, snapshotId]) => ({
      name,
      snapshotId,
      label: store.snapshots.find((snapshot) => snapshot.id === snapshotId)?.label ?? null,
    }));
