/**
 * Effect-native persistence for typed configuration over the Triples service.
 *
 * Config bodies, types, revisions, and release snapshots are immutable facts.
 * Git-style refs are the only moving records. The pure InMemoryConfigStore is
 * used to calculate and validate each transition, keeping one semantic model
 * for dangling refs, duplicate objects, revision reuse, and `validUnder`.
 */

import { Context, Data, Effect, Layer } from "effect";

import type {
  CommandAlreadyCommittedError,
  ConstraintViolationError,
  DatalogQueryError,
  ReadError,
  TransactionConflictError,
  WriteError,
} from "../errors/index.js";
import { Triples } from "../store/Triples.js";
import type { TransactionResult } from "../store/Triples.js";
import { transactSystem } from "../store/systemNamespace.js";
import type { Triple, TransactOp } from "../Triple.js";
import type { TripleValue } from "../Value.js";
import * as CanonicalJson from "../content/CanonicalJson.js";
import type * as ConfigNode from "./ConfigNode.js";
import * as InMemoryConfigStore from "./InMemoryConfigStore.js";
import type * as TypeExpr from "./TypeExpr.js";
import { unsafe, type EntityId } from "../Branded.js";

export type {
  ConfigSnapshot,
  ObjectChange,
  ObjectKey,
  RecheckResult,
  Revision,
  StoredObject,
} from "./InMemoryConfigStore.js";

export const System = {
  prefix: "_triplex/config/",
  entityType: {
    object: "triplex.config-object",
    type: "triplex.config-type",
    logicalObject: "triplex.config-logical-object",
    revision: "triplex.config-revision",
    snapshot: "triplex.config-snapshot",
    ref: "triplex.config-ref",
  },
  attribute: {
    data: ":triplex/config-data",
    contentId: ":triplex/content-id",
    kind: ":triplex/config-kind",
    key: ":triplex/config-key",
    validUnder: ":triplex/valid-under",
    dependsOn: ":triplex/depends-on",
    target: ":triplex/ref-target",
  },
} as const;

const encodePart = (value: string): string => encodeURIComponent(value);

export const entityId = {
  object: (cid: string): EntityId => unsafe.entityId(`${System.prefix}object/${cid}`),
  type: (cid: string): EntityId => unsafe.entityId(`${System.prefix}type/${cid}`),
  logicalObject: (object: InMemoryConfigStore.ObjectKey) =>
    unsafe.entityId(`${System.prefix}logical/${encodePart(object.kind)}/${encodePart(object.key)}`),
  revision: (id: string): EntityId => unsafe.entityId(`${System.prefix}revision/${encodePart(id)}`),
  snapshot: (id: string): EntityId => unsafe.entityId(`${System.prefix}snapshot/${encodePart(id)}`),
  ref: (name: string): EntityId => unsafe.entityId(`${System.prefix}ref/${encodePart(name)}`),
};

export class CorruptConfigStoreError extends Data.TaggedError("CorruptConfigStoreError")<{
  readonly entityId: string;
  readonly message: string;
}> {}

export type LoadError = ReadError | CorruptConfigStoreError;
export type CommitError =
  | LoadError
  | WriteError
  | TransactionConflictError
  | CommandAlreadyCommittedError
  | ConstraintViolationError
  | InMemoryConfigStore.DanglingRefError
  | InMemoryConfigStore.DuplicateObjectError
  | InMemoryConfigStore.UnknownSnapshotError
  | ConfigNode.DuplicateChildKeyError
  | ConfigNode.ConflictingClosureEntryError
  | CanonicalJson.CanonicalEncodingError;

export interface CommitInput {
  readonly label: string;
  readonly objects: ReadonlyArray<ConfigNode.ConfigNode>;
  /** Move this ref in the same transaction that records the release. */
  readonly ref?: string;
}

export interface CommitResult extends InMemoryConfigStore.CommitResult {
  readonly transaction: TransactionResult;
}

export interface ConfigStoreService {
  readonly load: () => Effect.Effect<InMemoryConfigStore.InMemoryConfigStore, LoadError>;
  readonly commit: (input: CommitInput) => Effect.Effect<CommitResult, CommitError>;
  readonly setRef: (
    name: string,
    snapshotId: InMemoryConfigStore.ConfigSnapshot["id"],
  ) => Effect.Effect<
    InMemoryConfigStore.ConfigSnapshot,
    | LoadError
    | WriteError
    | TransactionConflictError
    | CommandAlreadyCommittedError
    | ConstraintViolationError
    | InMemoryConfigStore.UnknownSnapshotError
  >;
  readonly resolveRef: (
    name: string,
  ) => Effect.Effect<InMemoryConfigStore.ConfigSnapshot | undefined, LoadError>;
  readonly snapshotById: (
    id: InMemoryConfigStore.ConfigSnapshot["id"],
  ) => Effect.Effect<InMemoryConfigStore.ConfigSnapshot | undefined, LoadError>;
  /** Revisions transitively depending on a logical config object. */
  readonly reverseDependencies: (
    object: InMemoryConfigStore.ObjectKey,
  ) => Effect.Effect<ReadonlyArray<InMemoryConfigStore.Revision>, LoadError | DatalogQueryError>;
  /** Alias that names the deploy-preview use of the reverse dependency index. */
  readonly impactCandidates: (
    object: InMemoryConfigStore.ObjectKey,
  ) => Effect.Effect<ReadonlyArray<InMemoryConfigStore.Revision>, LoadError | DatalogQueryError>;
  readonly recheck: (input: {
    readonly kind: string;
    readonly type: TypeExpr.TypeExpr;
  }) => Effect.Effect<InMemoryConfigStore.RecheckResult, LoadError>;
}

export class ConfigStore extends Context.Service<ConfigStore, ConfigStoreService>()(
  "triplex/ConfigStore",
) {}

type SnapshotRecord = Omit<InMemoryConfigStore.ConfigSnapshot, "root">;

const groupByEntity = (
  triples: ReadonlyArray<Triple>,
): ReadonlyMap<string, ReadonlyArray<Triple>> => {
  const grouped = new Map<string, Triple[]>();
  for (const triple of triples) {
    const current = grouped.get(triple.entityId) ?? [];
    current.push(triple);
    grouped.set(triple.entityId, current);
  }
  return grouped;
};

const latest = (triples: ReadonlyArray<Triple>, attribute: string): Triple | undefined =>
  triples
    .filter((triple) => triple.attribute === attribute)
    .sort((a, b) => b.recordedAt - a.recordedAt || b.id.localeCompare(a.id))[0];

const stringValue = (triple: Triple | undefined): string | undefined => {
  if (!triple) return undefined;
  return triple.value.type === "string" || triple.value.type === "ref"
    ? triple.value.value
    : undefined;
};

const jsonValue = <A>(triple: Triple | undefined): A | undefined =>
  triple?.value.type === "json" ? (triple.value.value as A) : undefined;

const corrupt = (id: string, reason: string) =>
  new CorruptConfigStoreError({
    entityId: id,
    message: `Invalid Triplex configuration record ${id}: ${reason}`,
  });

const assertOp = (
  id: string,
  entityType: string,
  attribute: string,
  value: TripleValue | { readonly type: "ref"; readonly value: string },
): TransactOp => ({
  op: "assert",
  entityId: unsafe.entityId(id),
  entityType,
  attribute,
  value: value.type === "ref" ? { ...value, value: unsafe.entityId(value.value) } : value,
});

const makeService = Effect.gen(function* () {
  const triples = yield* Triples;

  const records = (entityType: string) => triples.match({ entityType });

  const load: ConfigStoreService["load"] = () =>
    Effect.gen(function* () {
      const [objectRows, typeRows, revisionRows, snapshotRows, refRows] = yield* Effect.all([
        records(System.entityType.object),
        records(System.entityType.type),
        records(System.entityType.revision),
        records(System.entityType.snapshot),
        records(System.entityType.ref),
      ]);

      const objects = new Map<
        import("../content/ContentId.js").ContentId,
        InMemoryConfigStore.StoredObject
      >();
      for (const [id, rows] of groupByEntity(objectRows)) {
        const cid = stringValue(latest(rows, System.attribute.contentId));
        const kind = stringValue(latest(rows, System.attribute.kind));
        const body = jsonValue<CanonicalJson.CanonicalValue>(latest(rows, System.attribute.data));
        if (!cid || !kind || body === undefined) return yield* corrupt(id, "missing object data");
        const validUnder = rows
          .filter((row) => row.attribute === System.attribute.validUnder)
          .map((row) => stringValue(row))
          .filter(
            (value): value is import("../content/ContentId.js").ContentId => value !== undefined,
          )
          .sort();
        objects.set(cid as import("../content/ContentId.js").ContentId, {
          cid: cid as import("../content/ContentId.js").ContentId,
          kind,
          body,
          validUnder,
        });
      }

      const schemas = new Map<import("../content/ContentId.js").ContentId, TypeExpr.TypeExpr>();
      for (const [id, rows] of groupByEntity(typeRows)) {
        const cid = stringValue(latest(rows, System.attribute.contentId));
        const type = jsonValue<TypeExpr.TypeExpr>(latest(rows, System.attribute.data));
        if (!cid || type === undefined) return yield* corrupt(id, "missing type data");
        schemas.set(cid as import("../content/ContentId.js").ContentId, type);
      }

      const revisions: InMemoryConfigStore.Revision[] = [];
      for (const [id, rows] of groupByEntity(revisionRows)) {
        const revision = jsonValue<InMemoryConfigStore.Revision>(
          latest(rows, System.attribute.data),
        );
        if (!revision) return yield* corrupt(id, "missing revision data");
        revisions.push(revision);
      }
      revisions.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));

      const buildNode = (
        cid: import("../content/ContentId.js").ContentId,
        visiting = new Set<string>(),
      ): ConfigNode.ConfigNode => {
        const stored = objects.get(cid);
        if (!stored) throw corrupt(entityId.object(cid), "snapshot references a missing node");
        if (visiting.has(cid)) throw corrupt(entityId.object(cid), "child graph contains a cycle");
        const body = stored.body as unknown as {
          readonly kind: string;
          readonly key: string;
          readonly attrs: CanonicalJson.CanonicalValue;
          readonly children: ReadonlyArray<{
            readonly rel: string;
            readonly cid: import("../content/ContentId.js").ContentId;
          }>;
          readonly refs: ReadonlyArray<ConfigNode.ConfigRef>;
        };
        const nested = new Set(visiting).add(cid);
        const type = stored.validUnder
          .map((id) => schemas.get(id))
          .find((value) => value !== undefined);
        return {
          kind: body.kind,
          key: body.key,
          attrs: body.attrs,
          children: body.children.map((child) => ({
            rel: child.rel,
            node: buildNode(child.cid, nested),
          })),
          refs: body.refs,
          cid,
          ...(type !== undefined && { type }),
        };
      };

      const snapshots: InMemoryConfigStore.ConfigSnapshot[] = [];
      try {
        for (const [id, rows] of groupByEntity(snapshotRows)) {
          const record = jsonValue<SnapshotRecord>(latest(rows, System.attribute.data));
          if (!record) return yield* corrupt(id, "missing snapshot data");
          snapshots.push({ ...record, root: buildNode(record.rootCid) });
        }
      } catch (error) {
        if (error instanceof CorruptConfigStoreError) return yield* error;
        return yield* corrupt("<snapshot>", String(error));
      }
      snapshots.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));

      const refs = new Map<string, InMemoryConfigStore.ConfigSnapshot["id"]>();
      for (const [id, rows] of groupByEntity(refRows)) {
        const name = stringValue(latest(rows, System.attribute.key));
        const target = stringValue(latest(rows, System.attribute.target));
        if (!name || !target) return yield* corrupt(id, "missing ref target");
        const snapshot = snapshots.find((candidate) => entityId.snapshot(candidate.id) === target);
        if (!snapshot) return yield* corrupt(id, `points to unknown snapshot ${target}`);
        refs.set(name, snapshot.id);
      }

      const seq = Math.max(
        0,
        ...revisions.map((revision) => revision.seq),
        ...snapshots.map((snapshot) => snapshot.seq),
      );
      return { objects, schemas, revisions, snapshots, refs, seq };
    });

  const currentRefTriple = (name: string) =>
    triples
      .match({ entityId: entityId.ref(name) })
      .pipe(Effect.map((rows) => latest(rows, System.attribute.target)));

  const refOps = (
    name: string,
    snapshotId: string,
    current: Triple | undefined,
  ): ReadonlyArray<TransactOp> => [
    ...(current ? ([{ op: "retract", id: current.id }] as const) : []),
    assertOp(entityId.ref(name), System.entityType.ref, System.attribute.key, {
      type: "string",
      value: name,
    }),
    assertOp(entityId.ref(name), System.entityType.ref, System.attribute.target, {
      type: "ref",
      value: entityId.snapshot(snapshotId),
    }),
  ];

  const commit: ConfigStoreService["commit"] = (input) =>
    Effect.gen(function* () {
      const before = yield* load();
      const committed = yield* InMemoryConfigStore.commit(before, input);
      const operations: TransactOp[] = [];

      for (const [cid, stored] of committed.store.objects) {
        const previous = before.objects.get(cid);
        if (!previous) {
          operations.push(
            assertOp(entityId.object(cid), System.entityType.object, System.attribute.contentId, {
              type: "string",
              value: cid,
            }),
            assertOp(entityId.object(cid), System.entityType.object, System.attribute.kind, {
              type: "string",
              value: stored.kind,
            }),
            assertOp(entityId.object(cid), System.entityType.object, System.attribute.data, {
              type: "json",
              value: stored.body,
            }),
          );
        }
        for (const typeId of stored.validUnder) {
          if (previous?.validUnder.includes(typeId)) continue;
          operations.push(
            assertOp(entityId.object(cid), System.entityType.object, System.attribute.validUnder, {
              type: "string",
              value: typeId,
            }),
          );
        }
      }

      for (const [cid, type] of committed.store.schemas) {
        if (before.schemas.has(cid)) continue;
        operations.push(
          assertOp(entityId.type(cid), System.entityType.type, System.attribute.contentId, {
            type: "string",
            value: cid,
          }),
          assertOp(entityId.type(cid), System.entityType.type, System.attribute.data, {
            type: "json",
            value: type,
          }),
        );
      }

      for (const revision of committed.created) {
        const id = entityId.revision(revision.id);
        operations.push(
          assertOp(id, System.entityType.revision, System.attribute.data, {
            type: "json",
            value: revision,
          }),
          assertOp(id, System.entityType.revision, System.attribute.kind, {
            type: "string",
            value: revision.kind,
          }),
          assertOp(id, System.entityType.revision, System.attribute.key, {
            type: "string",
            value: revision.key,
          }),
          assertOp(id, System.entityType.revision, System.attribute.contentId, {
            type: "string",
            value: revision.cid,
          }),
        );
        for (const dep of revision.deps) {
          operations.push(
            assertOp(id, System.entityType.revision, System.attribute.dependsOn, {
              type: "ref",
              value: entityId.logicalObject(dep),
            }),
          );
        }
      }

      const { root: _root, ...snapshotRecord } = committed.snapshot;
      operations.push(
        assertOp(
          entityId.snapshot(committed.snapshot.id),
          System.entityType.snapshot,
          System.attribute.data,
          { type: "json", value: snapshotRecord },
        ),
      );

      if (input.ref) {
        const current = yield* currentRefTriple(input.ref);
        operations.push(...refOps(input.ref, committed.snapshot.id, current));
        const transaction = yield* transactSystem(triples, operations, {
          actor: "triplex/config-store",
          configSnapshot: committed.snapshot.id,
          ...(current ? { preconditions: [{ _tag: "TripleLive" as const, id: current.id }] } : {}),
        });
        const store = yield* InMemoryConfigStore.setRef(
          committed.store,
          input.ref,
          committed.snapshot.id,
        );
        return { ...committed, store, transaction };
      }

      const transaction = yield* transactSystem(triples, operations, {
        actor: "triplex/config-store",
        configSnapshot: committed.snapshot.id,
      });
      return { ...committed, store: committed.store, transaction };
    });

  const setRef: ConfigStoreService["setRef"] = (name, snapshotId) =>
    Effect.gen(function* () {
      const store = yield* load();
      const next = yield* InMemoryConfigStore.setRef(store, name, snapshotId);
      const current = yield* currentRefTriple(name);
      yield* transactSystem(triples, refOps(name, snapshotId, current), {
        actor: "triplex/config-store",
        configSnapshot: snapshotId,
        ...(current ? { preconditions: [{ _tag: "TripleLive" as const, id: current.id }] } : {}),
      });
      return InMemoryConfigStore.resolveRef(next, name)!;
    });

  const reverseDependencies: ConfigStoreService["reverseDependencies"] = (object) =>
    Effect.gen(function* () {
      const response = yield* triples.queryAll({
        find: ["?revision"],
        where: [
          [
            "?revision",
            System.attribute.dependsOn,
            { type: "ref", value: entityId.logicalObject(object) },
          ],
        ],
      });
      const ids = new Set(
        response.results
          .map((row) => row["?revision"])
          .filter((value): value is string => typeof value === "string"),
      );
      const store = yield* load();
      return store.revisions.filter((revision) => ids.has(entityId.revision(revision.id)));
    });

  return {
    load,
    commit,
    setRef,
    resolveRef: (name: string) =>
      load().pipe(Effect.map((store) => InMemoryConfigStore.resolveRef(store, name))),
    snapshotById: (id: string) =>
      load().pipe(Effect.map((store) => InMemoryConfigStore.snapshotById(store, id))),
    reverseDependencies,
    impactCandidates: reverseDependencies,
    recheck: (input: { readonly kind: string; readonly type: TypeExpr.TypeExpr }) =>
      load().pipe(Effect.map((store) => InMemoryConfigStore.recheck(store, input))),
  };
});

export const layer: Layer.Layer<ConfigStore, never, Triples> = Layer.effect(
  ConfigStore,
  makeService,
);
