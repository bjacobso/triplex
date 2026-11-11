/** Schema-bound application client. All storage access uses public Triples operations. */
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import type { EntityId, TripleId } from "../Branded.js";
import type { Triple, TransactOp, TransactionPrecondition } from "../Triple.js";
import type { TemporalBasis } from "../Temporal.js";
import * as Change from "../Change.js";
import type * as Attribute from "../config/Attribute.js";
import * as ConfigNode from "../config/ConfigNode.js";
import * as ConfigStore from "../config/ConfigStore.js";
import * as EntityType from "../config/EntityType.js";
import * as GraphConstraint from "../config/GraphConstraint.js";
import * as SchemaBound from "../config/SchemaBound.js";
import * as ContentId from "../content/ContentId.js";
import type { AppendEntryInput, EntryKind } from "../operational/Entry.js";
import type { DatalogQuery, WrappedQuery } from "../datalog/types.js";
import {
  Triples,
  type TransactionRecord,
  type PagedQueryOptions,
  type PagedQueryResponse,
} from "../store/Triples.js";
import {
  type DatalogQueryError,
  type WriteError,
  type CommandAlreadyCommittedError,
  type ConstraintViolationError,
  type OperationalEntryConflictError,
  type CommitRejectedError,
  type SensitiveValueError,
  ReadError,
  ValidationError,
  TripleNotFoundError,
  TransactionConflictError,
  PaginationCursorError,
} from "../errors/index.js";
import { previewCommand, type Preview, type PreviewOptions } from "./Preview.js";
export type { Preview, PreviewChange, PreviewOptions, PreviewDerivation } from "./Preview.js";
export { previewTransaction } from "./Preview.js";
import { Sensitivity } from "../sensitive/Sensitive.js";
import type { EntityPageSnapshot } from "../EntityPage.js";

/** Structural declaration boundary; individual method inputs retain their concrete declaration types. */
export interface ModelType {
  readonly entityType: string;
  readonly nodes: Effect.Effect<
    ReadonlyArray<ConfigNode.ConfigNode>,
    | ConfigNode.DuplicateChildKeyError
    | import("../content/CanonicalJson.js").CanonicalEncodingError
    | Schema.SchemaError
  >;
  readonly attributes: Readonly<
    Record<string, { readonly key: string; readonly definition: Attribute.AnyDefinition }>
  >;
  readonly assert: (...args: never[]) => ReadonlyArray<TransactOp>;
  readonly decode: (
    facts: ReadonlyArray<Triple>,
  ) => Effect.Effect<unknown, EntityType.EntityDecodeError>;
  readonly end: (fact: Triple, at: number) => Change.Change;
  readonly replace: (...args: never[]) => Change.Change;
  readonly correct: (...args: never[]) => Change.Change;
}

export type Entity<T extends ModelType> = {
  readonly entityId: EntityId;
  readonly values: T extends EntityType.EntityType<
    string,
    infer A extends Readonly<Record<string, Attribute.Use<Attribute.AnyDefinition>>>
  >
    ? EntityType.Decoded<A>
    : never;
};

/** Config and decoder failures are normalized to diagnostic-bearing read/validation errors. */
export type DatabaseError =
  | ReadError
  | ValidationError
  | TripleNotFoundError
  | WriteError
  | TransactionConflictError
  | CommandAlreadyCommittedError
  | ConstraintViolationError
  | OperationalEntryConflictError
  | CommitRejectedError
  | DatalogQueryError
  | PaginationCursorError
  | SensitiveValueError;

export interface CommandMeta {
  readonly actor: string;
  readonly commandId: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}
export interface Entries {
  readonly append: (input: AppendEntryInput) => Effect.Effect<void, DatabaseError>;
  readonly acknowledge: (id: ContentId.ContentId) => Effect.Effect<void, DatabaseError>;
}
export interface Command {
  readonly put: <T extends ModelType>(
    type: T,
    id: EntityId,
    values: Parameters<T["assert"]>[1],
    interval?: Attribute.AssertionOptions,
  ) => Effect.Effect<void, DatabaseError>;
  readonly create: Command["put"];
  readonly get: <T extends ModelType>(
    type: T,
    id: EntityId,
    options?: { readonly validAt?: number },
  ) => Effect.Effect<Entity<T> | null, DatabaseError>;
  readonly fact: <T extends ModelType>(
    type: T,
    id: TripleId,
  ) => Effect.Effect<Triple, DatabaseError>;
  readonly end: (type: ModelType, fact: Triple, at: number) => Effect.Effect<void, DatabaseError>;
  readonly replace: <T extends ModelType>(
    type: T,
    fact: Triple,
    value: Parameters<T["replace"]>[1],
    at: number,
  ) => Effect.Effect<void, DatabaseError>;
  readonly correct: <T extends ModelType>(
    type: T,
    fact: Triple,
    value: Parameters<T["correct"]>[1],
  ) => Effect.Effect<void, DatabaseError>;
  readonly retract: (type: ModelType, fact: Triple) => Effect.Effect<void, DatabaseError>;
  readonly inbox: Entries;
  readonly outbox: Entries;
}
export interface ListOptions {
  readonly limit?: number;
  readonly cursor?: string;
}
export type ReadOptions = Omit<PagedQueryOptions, "basis">;
export type QueryPage<A> = Omit<PagedQueryResponse, "results"> & {
  readonly results: ReadonlyArray<A>;
};
export interface Reads {
  readonly get: <T extends ModelType>(
    type: T,
    id: EntityId,
  ) => Effect.Effect<Entity<T> | null, DatabaseError>;
  readonly list: <T extends ModelType>(
    type: T,
    options?: ListOptions,
  ) => Effect.Effect<
    {
      readonly entities: ReadonlyArray<Entity<T>>;
      readonly snapshot: EntityPageSnapshot;
      readonly nextCursor?: string;
    },
    DatabaseError
  >;
  readonly query: <S extends Schema.Top & { readonly DecodingServices: never }>(
    query: DatalogQuery,
    options: ReadOptions & { readonly decode: S },
  ) => Effect.Effect<QueryPage<S["Type"]>, DatabaseError>;
  readonly raw: (
    query: DatalogQuery,
    options?: ReadOptions,
  ) => Effect.Effect<PagedQueryResponse, DatabaseError>;
  readonly rawPage: (
    query: WrappedQuery,
    options?: { readonly debug?: boolean },
  ) => Effect.Effect<PagedQueryResponse, DatabaseError>;
}
export interface View extends Reads {
  readonly basis: TemporalBasis;
  readonly releaseId: string;
}
export interface DatabaseService extends Reads {
  readonly command: <E, R>(
    meta: CommandMeta,
    build: (tx: Command) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<TransactionRecord, DatabaseError | E, R>;
  readonly preview: <E, R>(
    meta: CommandMeta,
    build: (tx: Command) => Effect.Effect<void, E, R>,
    options?: PreviewOptions,
  ) => Effect.Effect<Preview, DatabaseError | E, R>;
  readonly asOf: (basis: TemporalBasis) => Effect.Effect<View, DatabaseError>;
}
export class Database extends Context.Service<Database, DatabaseService>()("triplex/Database") {}
export interface LayerOptions {
  readonly schema: {
    readonly types: ReadonlyArray<ModelType>;
    readonly objects?: ReadonlyArray<ConfigNode.ConfigNode>;
  };
  readonly ref?: string;
}

const invalid = (field: string, cause?: unknown) =>
  Object.assign(
    new ValidationError({
      field,
      message: `Invalid Database input at ${field}. Correct the named field using the declared model and API.`,
    }),
    { cause },
  );
const readFailure = (cause: unknown) =>
  new ReadError({ message: "Could not read Database configuration or receipt", cause });
/** Catch only known pure-builder input exceptions; programmer defects remain defects. */
const pure = <A>(path: string, build: () => A): Effect.Effect<A, ValidationError> =>
  Effect.try({
    try: build,
    catch: (cause) => {
      if (cause instanceof TypeError || cause instanceof RangeError) return invalid(path, cause);
      throw cause;
    },
  });
const instant = (value: number, path: string) =>
  Number.isFinite(value) && value >= 0 ? Effect.void : Effect.fail(invalid(path));
const nodeKey = (node: ConfigNode.ConfigNode) => JSON.stringify([node.kind, node.key]);

interface Cursor {
  readonly version: 1;
  readonly kind: string;
  readonly release: string;
  readonly model: string;
  readonly inner: string;
}
const cursorError = (reason: PaginationCursorError["reason"] = "malformed", cause?: unknown) =>
  new PaginationCursorError({
    reason,
    message: "Database cursor does not match this read. Restart without a cursor.",
    cause,
  });
// Percent-encoded JSON is browser-safe and opaque to callers; the backend cursor is never interpreted.
const encodeCursor = (cursor: Cursor) => encodeURIComponent(JSON.stringify(cursor));
const decodeCursor = (input: string) =>
  Effect.try({
    try: () => {
      const c: unknown = JSON.parse(decodeURIComponent(input));
      if (
        typeof c !== "object" ||
        c === null ||
        !("version" in c) ||
        c.version !== 1 ||
        !("kind" in c) ||
        typeof c.kind !== "string" ||
        !("release" in c) ||
        typeof c.release !== "string" ||
        !("model" in c) ||
        typeof c.model !== "string" ||
        !("inner" in c) ||
        typeof c.inner !== "string"
      )
        throw cursorError();
      return c as Cursor;
    },
    catch: (cause) => cursorError("malformed", cause),
  });

export const layer = (
  options: LayerOptions,
): Layer.Layer<Database, DatabaseError, Triples | ConfigStore.ConfigStore> =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const triples = yield* Triples;
      const config = yield* ConfigStore.ConfigStore;
      const ref = options.ref ?? "live";
      const declared = new Map<string, ConfigNode.ConfigNode>();
      const nodes = yield* EntityType.nodesOf(...options.schema.types).pipe(
        Effect.mapError((cause) => invalid("schema.types", cause)),
      );
      for (const root of [...nodes, ...(options.schema.objects ?? [])]) {
        for (const { node } of ConfigNode.walk(root)) {
          const key = nodeKey(node);
          const previous = declared.get(key);
          if (previous !== undefined && previous.cid !== node.cid)
            return yield* invalid("schema.types");
          declared.set(key, node);
        }
      }
      const fingerprint = ContentId.hash(
        "triplex/database-model",
        JSON.stringify([...declared].map(([key, n]) => [key, n.cid]).sort()),
      );
      const compatible = new Set<string>();
      const check = (release: ConfigStore.ConfigSnapshot) =>
        Effect.gen(function* () {
          if (compatible.has(release.root.cid)) return;
          const actual = new Map(
            ConfigNode.walk(release.root).map(({ node }) => [nodeKey(node), node.cid]),
          );
          for (const [key, node] of declared) {
            if (actual.get(key) !== node.cid) return yield* invalid("schema.types");
          }
          compatible.add(release.root.cid);
        });
      const resolve = () =>
        Effect.gen(function* () {
          const release = yield* config.resolveRef(ref).pipe(Effect.mapError(readFailure));
          if (release === undefined) return yield* invalid("schema.ref");
          yield* check(release);
          return release;
        });
      const typeCheck = (type: ModelType) =>
        Effect.gen(function* () {
          const nodes = yield* EntityType.nodesOf(type).pipe(
            Effect.mapError((cause) => invalid("schema.types", cause)),
          );
          for (const root of nodes)
            for (const { node } of ConfigNode.walk(root)) {
              if (declared.get(nodeKey(node))?.cid !== node.cid)
                return yield* invalid("schema.types");
            }
        });
      const decode = <T extends ModelType>(
        type: T,
        id: EntityId,
        facts: ReadonlyArray<Triple>,
      ): Effect.Effect<Entity<T> | null, DatabaseError> =>
        Effect.gen(function* () {
          const selected = facts.filter(
            (f) => Option.isSome(f.entityType) && f.entityType.value === type.entityType,
          );
          if (selected.length === 0) return null;
          const values = yield* type
            .decode(selected)
            .pipe(Effect.mapError((cause) => invalid("entity.values", cause)));
          // type.decode is the authoritative decoder for the concrete declaration T.
          return { entityId: id, values } as Entity<T>;
        });
      const checkedTriples = (release: ConfigStore.ConfigSnapshot) =>
        Effect.gen(function* () {
          return yield* Triples.pipe(
            Effect.provide(
              SchemaBound.layer({ ref }).pipe(
                Layer.provide(
                  Layer.merge(
                    Layer.succeed(Triples, triples),
                    Layer.succeed(ConfigStore.ConfigStore, {
                      ...config,
                      resolveRef: () => Effect.succeed(release),
                    }),
                  ),
                ),
              ),
            ),
          );
        });
      const reads = (fixed?: {
        readonly release: ConfigStore.ConfigSnapshot;
        readonly basis: TemporalBasis;
      }): Reads => {
        const select = (kind: string, cursor?: string) =>
          Effect.gen(function* () {
            if (cursor === undefined)
              return { release: fixed?.release ?? (yield* resolve()), inner: undefined };
            const c = yield* decodeCursor(cursor);
            if (c.kind !== kind || c.model !== fingerprint)
              return yield* cursorError("query_mismatch");
            if (fixed && c.release !== fixed.release.id)
              return yield* cursorError("basis_mismatch");
            const release =
              fixed?.release ??
              (yield* config
                .snapshotById(c.release as ContentId.ContentId)
                .pipe(Effect.mapError(readFailure)));
            if (!release) return yield* cursorError("scope_mismatch");
            yield* check(release).pipe(
              Effect.mapError((cause) => cursorError("query_mismatch", cause)),
            );
            return { release, inner: c.inner };
          });
        const wrap = <P extends { readonly nextCursor?: string }>(
          kind: string,
          release: ConfigStore.ConfigSnapshot,
          page: P,
        ): P => ({
          ...page,
          ...(page.nextCursor === undefined
            ? {}
            : {
                nextCursor: encodeCursor({
                  version: 1,
                  kind,
                  release: release.id,
                  model: fingerprint,
                  inner: page.nextCursor,
                }),
              }),
        });
        const raw: Reads["raw"] = (query, opts = {}) =>
          Effect.gen(function* () {
            const { release, inner } = yield* select("raw", opts.cursor);
            const bound = yield* checkedTriples(release);
            const { cursor: _cursor, ...forward } = opts;
            return wrap(
              "raw",
              release,
              yield* bound.query(query, {
                ...forward,
                ...(inner === undefined ? {} : { cursor: inner }),
                ...(fixed ? { basis: fixed.basis } : {}),
              }),
            );
          });
        return {
          get: (type, id) =>
            Effect.gen(function* () {
              yield* typeCheck(type);
              if (!fixed) yield* resolve();
              return yield* decode(type, id, yield* triples.entity(id, fixed?.basis));
            }),
          list: (type, opts = {}) =>
            Effect.gen(function* () {
              yield* typeCheck(type);
              const { release, inner } = yield* select("list", opts.cursor);
              const page = yield* triples.entityPage({
                entityType: type.entityType,
                ...(opts.limit === undefined ? {} : { limit: opts.limit }),
                ...(inner === undefined ? {} : { cursor: inner }),
                ...(fixed ? { basis: fixed.basis } : {}),
              });
              const entities = yield* Effect.forEach(page.entities, (facts) =>
                decode(type, facts[0]!.entityId, facts),
              );
              return wrap("list", release, {
                ...page,
                entities: entities.filter((e) => e !== null),
              });
            }),
          raw,
          query: (query, opts) =>
            Effect.gen(function* () {
              const { decode: projection, cursor, ...rest } = opts;
              const { release, inner } = yield* select("query", cursor);
              const bound = yield* checkedTriples(release);
              const page = yield* bound.query(query, {
                ...rest,
                ...(inner === undefined ? {} : { cursor: inner }),
                ...(fixed ? { basis: fixed.basis } : {}),
              });
              const results = yield* Effect.forEach(page.results, (row, index) =>
                Schema.decodeUnknownEffect(projection)(row).pipe(
                  Effect.mapError((cause) => invalid(`results[${index}]`, cause)),
                ),
              );
              return wrap("query", release, { ...page, results });
            }),
          rawPage: (query, opts = {}) =>
            Effect.gen(function* () {
              const { release, inner } = yield* select("rawPage", query.cursor);
              const { cursor: _cursor, ...forward } = query;
              const bound = yield* checkedTriples(release);
              return wrap(
                "rawPage",
                release,
                yield* bound.queryPage(
                  { ...forward, ...(inner === undefined ? {} : { cursor: inner }) },
                  { ...opts, ...(fixed ? { basis: fixed.basis } : {}) },
                ),
              );
            }),
        };
      };
      const sensitivity = yield* Effect.serviceOption(Sensitivity);
      const compile = <E, R>(
        meta: CommandMeta,
        build: (tx: Command) => Effect.Effect<void, E, R>,
      ) =>
        Effect.gen(function* () {
          if (typeof meta.actor !== "string" || meta.actor.trim() === "")
            return yield* invalid("meta.actor");
          if (typeof meta.commandId !== "string" || meta.commandId.trim() === "")
            return yield* invalid("meta.commandId");
          for (const key of Object.keys(meta))
            if (!["actor", "commandId", "correlationId", "causationId"].includes(key))
              return yield* invalid(`meta.${key}`);
          if (meta.correlationId !== undefined && typeof meta.correlationId !== "string")
            return yield* invalid("meta.correlationId");
          if (meta.causationId !== undefined && typeof meta.causationId !== "string")
            return yield* invalid("meta.causationId");
          const existing = yield* triples.transactionByCommand(meta.commandId);
          if (existing) return { existing } as const;
          const release = yield* resolve();
          const pinned = yield* GraphConstraint.pinned(release).pipe(Effect.mapError(readFailure));
          const started = yield* Clock.currentTimeMillis;
          const fiberId = yield* Effect.fiberId;
          let active = true;
          const changes: Change.Change[] = [];
          const observed = new Map<EntityId, ReadonlyArray<Triple>>();
          const edited = new Set<TripleId>();
          const op = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | ValidationError> =>
            Effect.withFiber<A, E | ValidationError>((fiber) =>
              !active || fiber.id !== fiberId ? Effect.fail(invalid("command.builder")) : effect,
            );
          const add = (
            ops: ReadonlyArray<TransactOp>,
            preconditions: ReadonlyArray<TransactionPrecondition> = [],
          ) => {
            changes.push({ ops, preconditions });
          };
          const assert = <T extends ModelType>(
            type: T,
            id: EntityId,
            values: Parameters<T["assert"]>[1],
            interval: Attribute.AssertionOptions = {},
            create = false,
          ) =>
            op(
              Effect.gen(function* () {
                yield* typeCheck(type);
                if (interval.validFrom !== undefined)
                  yield* instant(interval.validFrom, "command.put.validFrom");
                if (interval.validTo !== undefined) {
                  yield* instant(interval.validTo, "command.put.validTo");
                  if (interval.validTo <= (interval.validFrom ?? started))
                    return yield* invalid("command.put.validTo");
                }
                const ops = yield* pure("command.put.values", () =>
                  type.assert(...([id, values, interval] as never[])),
                );
                if (ops.length === 0) return yield* invalid("command.put.values");
                add(ops, create ? [{ _tag: "EntityAbsent", entityId: id }] : []);
              }),
            );
          const source = (type: ModelType, fact: Triple) =>
            Effect.gen(function* () {
              yield* typeCheck(type);
              if (
                Option.isNone(fact.entityType) ||
                fact.entityType.value !== type.entityType ||
                !Object.values(type.attributes).some((h) => h.key === fact.attribute)
              )
                return yield* invalid("command.fact");
              if (Option.isSome(fact.retractedAt))
                return yield* new TransactionConflictError({
                  tripleId: fact.id,
                  message: "Source fact is already retracted",
                });
            });
          const edit = (type: ModelType, fact: Triple, path: string, change: () => Change.Change) =>
            op(
              Effect.gen(function* () {
                yield* source(type, fact);
                if (edited.has(fact.id)) return yield* invalid(path);
                const compiled = yield* pure(path, change);
                edited.add(fact.id);
                changes.push(compiled);
              }),
            );
          const entries = (kind: EntryKind): Entries => ({
            append: (input) => op(Effect.sync(() => add([{ op: "append-entry", kind, ...input }]))),
            acknowledge: (id) =>
              op(Effect.sync(() => add([{ op: "acknowledge-entry", kind, id }]))),
          });
          const tx: Command = {
            put: assert,
            create: (type, id, values, interval) => assert(type, id, values, interval, true),
            get: (type, id, opts = {}) =>
              op(
                Effect.gen(function* () {
                  yield* typeCheck(type);
                  const validAt = opts.validAt ?? started;
                  yield* instant(validAt, "command.get.validAt");
                  let facts = observed.get(id);
                  if (!facts) {
                    facts = yield* triples.liveFacts(id);
                    observed.set(id, facts);
                    add(
                      [],
                      [{ _tag: "EntityState", entityId: id, tripleIds: facts.map((f) => f.id) }],
                    );
                  }
                  return yield* decode(
                    type,
                    id,
                    facts.filter(
                      (f) =>
                        f.validFrom <= validAt &&
                        (Option.isNone(f.validTo) || f.validTo.value > validAt),
                    ),
                  );
                }),
              ),
            fact: (type, id) =>
              op(
                Effect.gen(function* () {
                  const fact = yield* triples.get(id);
                  if (!fact) return yield* new TripleNotFoundError({ tripleId: id });
                  yield* source(type, fact);
                  return fact;
                }),
              ),
            end: (type, fact, at) => edit(type, fact, "command.end.at", () => type.end(fact, at)),
            replace: (type, fact, value, at) =>
              edit(type, fact, "command.replace.at", () =>
                type.replace(...([fact, value, at] as never[])),
              ),
            correct: (type, fact, value) =>
              edit(type, fact, "command.correct", () =>
                type.correct(...([fact, value] as never[])),
              ),
            retract: (type, fact) =>
              edit(type, fact, "command.retract", () => ({
                ops: [{ op: "retract", id: fact.id }],
                preconditions: [{ _tag: "TripleLive", id: fact.id }],
              })),
            inbox: entries("inbox"),
            outbox: entries("outbox"),
          };
          yield* Effect.suspend(() => build(tx)).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                active = false;
              }),
            ),
          );
          const combined = Change.combine(...changes);
          return { combined, release, pinned, started } as const;
        });
      yield* resolve();
      return {
        ...reads(),
        asOf: (basis) =>
          Effect.gen(function* () {
            if (basis.recordedAt !== undefined && basis.recordedPosition !== undefined)
              return yield* invalid("basis.recordedAt");
            for (const [key, value] of Object.entries(basis))
              if (value !== undefined) yield* instant(value, `basis.${key}`);
            const release = yield* resolve();
            const validAt = basis.validAt ?? (yield* Clock.currentTimeMillis);
            let recordedPosition: number;
            if (basis.recordedAt !== undefined) {
              recordedPosition = (yield* triples.resolveRecordedBasis({
                recordedAt: basis.recordedAt,
              })).recordedPosition;
            } else {
              const head = yield* triples.currentPosition();
              if (
                basis.recordedPosition !== undefined &&
                (!Number.isSafeInteger(basis.recordedPosition) || basis.recordedPosition > head)
              )
                return yield* invalid("basis.recordedPosition");
              recordedPosition = basis.recordedPosition ?? head;
            }
            const captured = Object.freeze({ recordedPosition, validAt });
            return {
              ...reads({ release, basis: captured }),
              basis: captured,
              releaseId: release.id,
            };
          }),
        preview: (meta, build, opts = {}) =>
          Effect.gen(function* () {
            const compiled = yield* compile(meta, build);
            if (compiled.existing)
              return {
                release: compiled.existing.configSnapshot ?? null,
                operations: { ops: [], preconditions: [] },
                changes: [],
                violations: [],
                derivations: [],
                commandAlreadyCommitted: compiled.existing,
              };
            return yield* previewCommand(triples, compiled, opts, sensitivity);
          }),
        command: (meta, build) =>
          Effect.gen(function* () {
            const compiled = yield* compile(meta, build);
            if (compiled.existing) return compiled.existing;
            const { combined, pinned } = compiled;
            const result = yield* triples
              .transact(combined.ops, { ...meta, ...pinned, preconditions: combined.preconditions })
              .pipe(
                Effect.map((result) => ({ duplicate: false as const, txId: result.txId })),
                Effect.catchTag("CommandAlreadyCommittedError", () =>
                  Effect.succeed({ duplicate: true as const }),
                ),
              );
            const receipt = yield* result.duplicate
              ? triples.transactionByCommand(meta.commandId)
              : triples.transaction(result.txId);
            if (!receipt) return yield* readFailure("Committed command receipt is missing");
            return receipt;
          }),
      } satisfies DatabaseService;
    }),
  );
