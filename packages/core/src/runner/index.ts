/** Durable, scoped derivation delivery. One host-assigned owner per database. */
import { Clock, Data, Deferred, Effect, Fiber, Schema, Semaphore, type Scope } from "effect";
import { Triples, type TransactionRecord } from "../store/Triples.js";
import { EntityId, TripleId, TransactionId, unsafe } from "../Branded.js";
import type { TransactOp, Triple } from "../Triple.js";
import * as Derivation from "../derivation/Derivation.js";
import * as Materialization from "../derivation/Materialization.js";
import { Outbox, ConsumerCheckpoint } from "../operational/index.js";
import { encodeOrThrow, type CanonicalValue } from "../content/CanonicalJson.js";
import { hash, ContentIdSchema, Domain } from "../content/ContentId.js";
import { validateDatabaseScope, type DatabaseScope } from "../runtime/DatabaseScope.js";
import { Constant as ConstantSchema } from "../datalog/schema.js";
import * as Attribute from "../config/Attribute.js";
import * as ConfigNode from "../config/ConfigNode.js";
import * as TypeExpr from "../config/TypeExpr.js";

export interface Delivery {
  readonly version: 1;
  readonly batchId: string;
  readonly registration: string;
  readonly definitionId: string;
  readonly configSnapshot: string;
  readonly previousRunId: string | null;
  readonly runId: string;
  readonly position: number;
  readonly sourcePosition: number;
  readonly basis: { readonly recordedPosition: number; readonly validAt: number };
  readonly reason: "initial" | "commit" | "time" | "definition";
  readonly diff: Derivation.Reconciliation;
  readonly attempt: number;
  readonly commandId: (kind: "added" | "removed" | "changed", candidateId: string) => string;
}
export interface Registration<E, R> {
  readonly key: string;
  readonly definition: Derivation.Definition;
  readonly onDiff: (delivery: Delivery) => Effect.Effect<void, E, R>;
}
export class RunnerError extends Data.TaggedError("RunnerError")<{
  readonly code:
    | "Options"
    | "AlreadyRunning"
    | "DuplicateKey"
    | "UnsupportedDefinition"
    | "GenerationChanged"
    | "MissingDefinition"
    | "CorruptState"
    | "Store"
    | "PayloadLimit";
  readonly message: string;
  readonly cause?: unknown;
}> {}
export interface RegistrationStatus {
  readonly key: string;
  readonly deliveredPosition: number;
  readonly acknowledgedRun: string | null;
  readonly pending: {
    readonly batchId: string;
    readonly attempt: number;
    readonly paused: boolean;
    readonly retryAt: number | null;
    readonly error: unknown;
  } | null;
  readonly nextDeadline: number | null;
}
export interface RunnerStatus {
  readonly consumer: string;
  readonly scannedPosition: number;
  readonly deliveredPosition: number;
  readonly lag: number;
  readonly evaluationTimeMs: number;
  readonly timerLatenessMs: number;
  readonly registrations: readonly RegistrationStatus[];
}
export interface Handle<E> {
  readonly await: Effect.Effect<never, RunnerError | E>;
  readonly stop: Effect.Effect<void>;
  readonly status: Effect.Effect<RunnerStatus>;
  readonly retryPaused: (registration: string) => Effect.Effect<void, RunnerError>;
}
export interface Options {
  readonly scope: DatabaseScope;
  readonly id: string;
  readonly idleCheckMs?: number;
  readonly evaluationConcurrency?: number;
  readonly maxCandidates?: number;
  readonly maxPayloadBytes?: number;
  readonly retry?: {
    readonly maxAttempts?: number;
    readonly initialDelayMs?: number;
    readonly maxDelayMs?: number;
    readonly random?: () => number;
  };
  /** Old deployed definitions required to finish prepared work after a revision. */
  readonly recoveryDefinitions?: readonly Derivation.Definition[];
}

/** Publish these ordinary infrastructure schema nodes with the host's release. */
const Body = Attribute.text(":runner/body");
const RecordHash = Attribute.text(":runner/hash");
export const Control = {
  entityType: "runner/control",
  nodes: Effect.all([
    Body.node,
    RecordHash.node,
    ConfigNode.makeTyped({
      kind: "entity-schema",
      key: "runner/control",
      type: TypeExpr.struct({
        entityType: TypeExpr.required(TypeExpr.text),
        type: TypeExpr.required(TypeExpr.any),
        attributes: TypeExpr.required(TypeExpr.any),
      }),
      attrs: {
        entityType: "runner/control",
        type: TypeExpr.struct({
          ":runner/body": TypeExpr.required(TypeExpr.text),
          ":runner/hash": TypeExpr.required(TypeExpr.text),
        }),
        attributes: {
          body: { attribute: Body.key, required: true, cardinality: "one", unique: false },
          hash: { attribute: RecordHash.key, required: true, cardinality: "one", unique: false },
        },
      },
      refs: [
        { rel: "uses-attribute", kind: Attribute.KIND, key: Body.key },
        { rel: "uses-attribute", kind: Attribute.KIND, key: RecordHash.key },
      ],
    }),
  ]),
} as const;
export const schema = Control.nodes;
const canonical = (value: unknown) => encodeOrThrow(value as CanonicalValue);
const digest = (kind: string, value: unknown) => hash(`triplex/runner/${kind}`, canonical(value));
const error = (code: RunnerError["code"], message: string, cause?: unknown) =>
  new RunnerError({ code, message, ...(cause === undefined ? {} : { cause }) });
const store = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, RunnerError, R> =>
  effect.pipe(
    Effect.mapError((cause) =>
      cause instanceof RunnerError
        ? cause
        : error("Store", "Runner storage operation failed", cause),
    ),
  );
const owners = new Map<string, object>();
const Basis = Schema.Struct({ recordedPosition: Schema.Number, validAt: Schema.Number });
const CandidateSchema = Schema.Struct({
  id: ContentIdSchema,
  revision: ContentIdSchema,
  definitionId: ContentIdSchema,
  configSnapshot: Schema.String,
  identity: Schema.Record(Schema.String, Schema.NullOr(ConstantSchema)),
  result: Schema.Record(Schema.String, Schema.NullOr(ConstantSchema)),
  basis: Basis,
  sources: Schema.Array(
    Schema.Struct({
      tripleId: TripleId,
      transactionId: Schema.optionalKey(TransactionId),
      transactionPosition: Schema.optionalKey(Schema.Number),
      entityId: EntityId,
      attribute: Schema.String,
      validFrom: Schema.Number,
      validTo: Schema.optionalKey(Schema.Number),
    }),
  ),
  nextTemporalBoundary: Schema.optionalKey(Schema.Number),
});
// Prepared metadata pins identity before evaluation; ready payloads live in the Outbox.
const PendingSchema = Schema.Struct({
  batchId: Schema.String,
  predecessor: Schema.NullOr(Schema.String),
  definitionId: Schema.String,
  basis: Basis,
  reason: Schema.Literals(["initial", "commit", "time", "definition"]),
  phase: Schema.Literals(["prepared", "ready"]),
  attempt: Schema.Number,
  cycleAttempt: Schema.Number,
  paused: Schema.Boolean,
  retryAt: Schema.NullOr(Schema.Number),
  failure: Schema.NullOr(Schema.String),
  payload: Schema.NullOr(Schema.String),
});
const StateSchema = Schema.Struct({
  version: Schema.Literal(1),
  key: Schema.String,
  name: Schema.String,
  definitionId: Schema.String,
  configSnapshot: Schema.String,
  runId: Schema.NullOr(ContentIdSchema),
  headBatch: Schema.NullOr(ContentIdSchema),
  candidates: Schema.Array(CandidateSchema),
  basis: Basis,
  coverage: Schema.Number,
  frontier: Schema.Number,
  deadline: Schema.NullOr(Schema.Number),
  pending: Schema.NullOr(PendingSchema),
});
type Pending = typeof PendingSchema.Type;
type State = Omit<typeof StateSchema.Type, "candidates"> & {
  readonly candidates: readonly Derivation.Candidate[];
};
interface Payload {
  readonly version: 1;
  readonly batchId: string;
  readonly registration: string;
  readonly definitionId: string;
  readonly configSnapshot: string;
  readonly previousRunId: string | null;
  readonly runId: string;
  readonly position: number;
  readonly sourcePosition: number;
  readonly basis: typeof Basis.Type;
  readonly reason: Delivery["reason"];
  readonly before: readonly Derivation.Candidate[];
  readonly after: readonly Derivation.Candidate[];
  readonly deadline: number | null;
}
const PayloadSchema = Schema.Struct({
  version: Schema.Literal(1),
  batchId: ContentIdSchema,
  registration: Schema.String,
  definitionId: ContentIdSchema,
  configSnapshot: Schema.String,
  previousRunId: Schema.NullOr(ContentIdSchema),
  runId: ContentIdSchema,
  position: Schema.Number,
  sourcePosition: Schema.Number,
  basis: Basis,
  reason: Schema.Literals(["initial", "commit", "time", "definition"]),
  before: Schema.Array(CandidateSchema),
  after: Schema.Array(CandidateSchema),
  deadline: Schema.NullOr(Schema.Number),
});
const runIdentity = (b: Payload) =>
  hash(
    Domain.derivationRun,
    canonical({
      v: 2,
      definition: b.definitionId,
      configSnapshot: b.configSnapshot,
      sourcePosition: b.sourcePosition,
      basis: b.basis,
      candidates: b.after.map((c) => c.revision).sort(),
      nextTemporalBoundary: b.deadline,
    }),
  );
const maintenance = (tx: TransactionRecord) =>
  (tx.actor === "triplex/runner" && tx.changes.every((c) => c.attribute.startsWith(":runner/"))) ||
  (tx.actor === "triplex/derivation-materializer" &&
    tx.changes.every(
      (c) =>
        c.attribute.startsWith(":triplex/derivation-") || c.attribute === ":triplex/content-id",
    ));
const relevant = (d: Derivation.Definition, tx: TransactionRecord) =>
  !maintenance(tx) &&
  (d.dependencies.hasDynamicAttributes ||
    tx.changes.some((c) => d.dependencies.attributes.includes(c.attribute)));
const hasDiff = (diff: Derivation.Reconciliation) =>
  diff.added.length + diff.removed.length + diff.changed.length > 0;
const freeze = <A>(value: A): A => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const finite = (n: number) => Number.isSafeInteger(n) && n >= 0;
const candidatesValid = (name: string, candidates: readonly Derivation.Candidate[]) =>
  Array.isArray(candidates) &&
  new Set(candidates.map((c) => c.id)).size === candidates.length &&
  candidates.every(
    (c) =>
      c &&
      c.id === Derivation.candidateIdentityId(name, c.identity) &&
      c.revision === Derivation.candidateRevisionId(c) &&
      finite(c.basis.validAt),
  );

/** Acquisition validates all retained state before starting any callbacks. */
export const start = <E, R>(
  registrations: readonly Registration<E, R>[],
  options: Options,
): Effect.Effect<Handle<E>, RunnerError, Triples | Scope.Scope | R> =>
  Effect.suspend(() => {
    let acquisitionCleanup = () => {};
    return Effect.gen(function* () {
      yield* Effect.try({
        try: () => validateDatabaseScope(options.scope),
        catch: (cause) => error("Options", "A server-resolved DatabaseScope is required", cause),
      });
      const idle = options.idleCheckMs ?? 1000;
      const concurrency = options.evaluationConcurrency ?? 4;
      const maxCandidates = options.maxCandidates ?? 10_000;
      const maxPayload = options.maxPayloadBytes ?? 16_000_000;
      const maxAttempts = options.retry?.maxAttempts ?? 8;
      const initialDelay = options.retry?.initialDelayMs ?? 1000;
      const maxDelay = options.retry?.maxDelayMs ?? 60_000;
      if (
        !options.id ||
        ![idle, concurrency, maxCandidates, maxPayload, maxAttempts, initialDelay, maxDelay].every(
          (n) => finite(n) && n > 0,
        ) ||
        idle > 1000 ||
        initialDelay > maxDelay
      )
        return yield* error("Options", "Invalid runner ID, limits or retry policy");
      if (new Set(registrations.map((r) => r.key)).size !== registrations.length)
        return yield* error("DuplicateKey", "Registration keys must be unique");
      const definitions = new Map<string, Derivation.Definition>();
      for (const d of [
        ...registrations.map((r) => r.definition),
        ...(options.recoveryDefinitions ?? []),
      ]) {
        const cloned = yield* Effect.try({
          try: () => JSON.parse(canonical(d)) as Derivation.Definition,
          catch: (cause) =>
            error("UnsupportedDefinition", "Definition must be canonical JSON", cause),
        });
        const checked = yield* Derivation.make(cloned).pipe(
          Effect.mapError((cause) =>
            error("UnsupportedDefinition", "Unsupported derivation", cause),
          ),
        );
        if (
          checked.dependencies.hasDynamicAttributes ||
          checked.query.where.some(
            (clause) =>
              Array.isArray(clause) &&
              (clause.length === 4 ||
                (clause[0] === "not" && Array.isArray(clause[1]) && clause[1].length === 4)),
          )
        )
          return yield* error(
            "UnsupportedDefinition",
            "Runner derivations require fixed attributes and no transaction-binding clauses",
          );
        if (checked.id !== d.id)
          return yield* error(
            "UnsupportedDefinition",
            "Definition content ID does not match its body",
          );
        definitions.set(d.id, checked);
      }
      registrations = registrations.map((r) => ({
        ...r,
        definition: definitions.get(r.definition.id)!,
      }));
      if (registrations.some((r) => !r.key))
        return yield* error("Options", "Registration keys must not be empty");
      const identity = JSON.parse(options.scope) as [string, string, string, string, number];
      const owner = canonical(identity.slice(0, 4));
      const localScope = options.scope;
      if (owners.has(localScope))
        return yield* error(
          "AlreadyRunning",
          "A runner already owns this database scope in this process",
        );
      const ownership = {};
      acquisitionCleanup = () => {
        if (owners.get(localScope) === ownership) owners.delete(localScope);
      };
      const releaseOwner = () => {
        if (owners.get(localScope) === ownership) owners.delete(localScope);
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => owners.set(localScope, ownership)),
        () => Effect.sync(releaseOwner),
      );
      const t = yield* Triples;
      const root = unsafe.entityId(`runner:${digest("control", [owner, options.id])}`);
      const consumer = `runner:${digest("consumer", [options.scope, options.id])}`;
      const locks = yield* Semaphore.make(1);
      const permits = yield* Semaphore.make(concurrency);
      const fatal = Deferred.makeUnsafe<never, RunnerError | E>();
      let pulse = Deferred.makeUnsafe<void>();
      const wake = () => {
        Deferred.doneUnsafe(pulse, Effect.void);
        pulse = Deferred.makeUnsafe<void>();
      };
      let stopped = false;
      let head = yield* store(t.currentPosition());
      let scannedPosition = head;
      let evaluationTimeMs = 0;
      let timerLatenessMs = 0;
      let checkpoint = (yield* store(ConsumerCheckpoint.get(t, consumer)))?.position ?? 0;
      const load = (id: string) => store(t.liveFacts(unsafe.entityId(id)));
      const decode = (rows: readonly Triple[]): Effect.Effect<unknown, RunnerError> =>
        Effect.try({
          try: () => {
            const bodies = rows.filter((r) => r.attribute === ":runner/body");
            const hashes = rows.filter((r) => r.attribute === ":runner/hash");
            if (
              rows.length !== 2 ||
              bodies.length !== 1 ||
              hashes.length !== 1 ||
              bodies[0]!.value.type !== "string" ||
              hashes[0]!.value.type !== "string"
            )
              throw new Error("Malformed control facts");
            const value: unknown = JSON.parse(bodies[0]!.value.value);
            if (digest("record", value) !== hashes[0]!.value.value)
              throw new Error("Control content hash mismatch");
            return value;
          },
          catch: (cause) => error("CorruptState", "Malformed runner control record", cause),
        });
      const save = (
        id: string,
        rows: readonly Triple[],
        body: unknown,
        extra: readonly TransactOp[] = [],
      ) =>
        store(
          t.transact(
            [
              ...rows.map((r) => ({ op: "retract" as const, id: r.id })),
              {
                op: "assert",
                entityId: unsafe.entityId(id),
                entityType: Control.entityType,
                attribute: ":runner/body",
                value: { type: "string", value: canonical(body) },
                validFrom: 0,
              },
              {
                op: "assert",
                entityId: unsafe.entityId(id),
                entityType: Control.entityType,
                attribute: ":runner/hash",
                value: { type: "string", value: digest("record", body) },
                validFrom: 0,
              },
              ...extra,
            ],
            {
              actor: "triplex/runner",
              commandId: digest("transition", [id, rows.map((r) => r.id).sort(), body, extra]),
              preconditions: rows.length
                ? [
                    {
                      _tag: "EntityState",
                      entityId: unsafe.entityId(id),
                      tripleIds: rows.map((r) => r.id),
                    },
                  ]
                : [{ _tag: "EntityAbsent", entityId: unsafe.entityId(id) }],
            },
          ),
        );
      const rootRows = yield* load(root);
      const manifest = rootRows.length
        ? yield* decode(rootRows).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  version: Schema.Literal(1),
                  scope: Schema.String,
                  keys: Schema.Array(Schema.String),
                  completed: Schema.Number,
                }),
              ),
            ),
            Effect.mapError((cause) => error("CorruptState", "Malformed runner manifest", cause)),
          )
        : {
            version: 1 as const,
            scope: options.scope,
            keys: [] as readonly string[],
            completed: 0,
          };
      if (manifest.scope !== options.scope)
        return yield* error(
          "GenerationChanged",
          "Database generation changed; explicit migration is required",
        );
      if (
        !finite(manifest.completed) ||
        checkpoint > manifest.completed ||
        manifest.completed > head
      )
        return yield* error("CorruptState", "Ahead checkpoint or invalid completed-cut marker");
      if (checkpoint < manifest.completed) {
        yield* store(
          ConsumerCheckpoint.advance(t, {
            consumer,
            expectedPosition: checkpoint,
            nextPosition: manifest.completed,
          }),
        );
        checkpoint = manifest.completed;
      }
      type Local = {
        registration: Registration<E, R>;
        id: string;
        rows: readonly Triple[];
        state: State;
        cursor: number;
        busy: boolean;
        failure: unknown;
      };
      const locals: Local[] = [];
      const validateState = (value: unknown) =>
        Schema.decodeUnknownEffect(StateSchema)(value).pipe(
          Effect.flatMap((s) =>
            Effect.try({
              try: () => {
                if (
                  !finite(s.coverage) ||
                  (s.runId === null) !== (s.headBatch === null) ||
                  (s.runId === null && (s.candidates.length > 0 || s.pending === null)) ||
                  (s.runId !== null && s.basis.recordedPosition > s.coverage) ||
                  s.frontier < s.basis.validAt ||
                  s.coverage > head ||
                  !finite(s.frontier) ||
                  !finite(s.basis.recordedPosition) ||
                  s.basis.recordedPosition > head ||
                  !finite(s.basis.validAt) ||
                  (s.deadline !== null && (!finite(s.deadline) || s.deadline <= s.frontier)) ||
                  !candidatesValid(s.name, s.candidates as readonly Derivation.Candidate[])
                )
                  throw new Error("Invalid head or candidate snapshot");
                const p = s.pending;
                if (
                  p &&
                  (!finite(p.attempt) ||
                    !finite(p.cycleAttempt) ||
                    (p.retryAt !== null && !finite(p.retryAt)) ||
                    p.cycleAttempt > p.attempt ||
                    (p.phase === "prepared" && p.payload !== null) ||
                    (p.phase === "ready" && p.payload === null) ||
                    !finite(p.basis.recordedPosition) ||
                    p.basis.recordedPosition > head ||
                    !finite(p.basis.validAt) ||
                    p.predecessor !== s.headBatch ||
                    p.batchId !==
                      digest("batch", [
                        1,
                        options.scope,
                        options.id,
                        s.key,
                        p.predecessor,
                        p.definitionId,
                        p.basis,
                      ]))
                )
                  throw new Error("Inconsistent pending predecessor or basis");
                return s as State;
              },
              catch: (cause) => error("CorruptState", "Invalid registration control", cause),
            }),
          ),
          Effect.mapError((cause) =>
            cause instanceof RunnerError
              ? cause
              : error("CorruptState", "Malformed registration control", cause),
          ),
        );
      for (const key of manifest.keys)
        if (!registrations.some((r) => r.key === key)) {
          const rows = yield* load(`${root}:${digest("key", key)}`);
          const s = yield* validateState(yield* decode(rows));
          if (s.pending)
            return yield* error(
              "MissingDefinition",
              `Drain registration ${key} before removing it`,
            );
          let after = s.coverage;
          while (after < head) {
            const page = yield* store(t.transactions({ after, limit: 1000 }));
            const retained = page.transactions.filter((tx) => tx.position <= head);
            if (retained.some((tx) => !maintenance(tx)))
              return yield* error(
                "MissingDefinition",
                `Drain registration ${key} before removing it`,
              );
            if (!retained.length) break;
            after = retained[retained.length - 1]!.position;
          }
        }
      const now = yield* Clock.currentTimeMillis;
      for (const registration of registrations) {
        const id = `${root}:${digest("key", registration.key)}`;
        const rows = yield* load(id);
        const state: State = rows.length
          ? yield* validateState(yield* decode(rows))
          : {
              version: 1,
              key: registration.key,
              name: registration.definition.name,
              definitionId: registration.definition.id,
              configSnapshot: registration.definition.configSnapshot,
              runId: null,
              headBatch: null,
              candidates: [],
              basis: { recordedPosition: head, validAt: now },
              coverage: checkpoint,
              frontier: now,
              deadline: null,
              pending: null,
            };
        if (state.key !== registration.key || state.name !== registration.definition.name)
          return yield* error(
            "MissingDefinition",
            "Registration name cannot change under an existing key",
          );
        if (state.pending && !definitions.has(state.pending.definitionId))
          return yield* error(
            "MissingDefinition",
            `Deploy definition ${state.pending.definitionId} for recovery`,
          );
        locals.push({
          registration,
          id,
          rows,
          state,
          cursor: state.coverage,
          busy: false,
          failure: null,
        });
      }
      const update = (l: Local, s: State, extra: readonly TransactOp[] = []) =>
        Effect.gen(function* () {
          yield* save(l.id, l.rows, s, extra);
          l.rows = yield* load(l.id);
          l.state = s;
        });
      const prepare = (l: Local, basis: typeof Basis.Type, reason: Delivery["reason"]) => {
        const definitionId = l.registration.definition.id;
        const pending: Pending = {
          batchId: digest("batch", [
            1,
            options.scope,
            options.id,
            l.state.key,
            l.state.headBatch,
            definitionId,
            basis,
          ]),
          predecessor: l.state.headBatch,
          definitionId,
          basis,
          reason,
          phase: "prepared",
          attempt: 0,
          cycleAttempt: 0,
          paused: false,
          retryAt: null,
          failure: null,
          payload: null,
        };
        return update(l, { ...l.state, pending });
      };
      // Persist bootstrap bases before returning, including empty relations.
      for (const l of locals)
        if (!l.rows.length) {
          yield* prepare(l, l.state.basis, "initial");
        }
      yield* save(root, rootRows, { ...manifest, keys: registrations.map((r) => r.key) });
      // The completed-cut marker precedes the unjournaled checkpoint write for crash repair.
      const advanceCheckpoint = locks.withPermits(1)(
        Effect.gen(function* () {
          const completed = locals.length
            ? Math.min(...locals.map((l) => l.state.coverage))
            : checkpoint;
          if (completed <= checkpoint) return;
          const rows = yield* load(root);
          yield* save(root, rows, {
            version: 1,
            scope: options.scope,
            keys: registrations.map((r) => r.key),
            completed,
          });
          const current = (yield* store(ConsumerCheckpoint.get(t, consumer)))?.position ?? 0;
          if (current > completed)
            return yield* error("CorruptState", "Checkpoint advanced beyond completed coverage");
          if (current < completed)
            yield* store(
              ConsumerCheckpoint.advance(t, {
                consumer,
                expectedPosition: current,
                nextPosition: completed,
              }),
            );
          checkpoint = completed;
        }),
      );
      const payloadOf = (l: Local, p: Pending) =>
        Effect.gen(function* () {
          const entry = yield* store(Outbox.get(t, Outbox.id(root, p.batchId)));
          if (
            !entry ||
            entry.acknowledgedPosition !== undefined ||
            p.payload === null ||
            canonical(entry.payload) !== p.payload
          )
            return yield* error("CorruptState", "Missing or conflicting pending Outbox payload");
          return yield* Effect.try({
            try: () => {
              const b = Schema.decodeUnknownSync(PayloadSchema)(JSON.parse(p.payload!));
              if (
                b.version !== 1 ||
                b.runId !== runIdentity(b) ||
                b.after.some(
                  (c) => c.definitionId !== b.definitionId || c.configSnapshot !== b.configSnapshot,
                ) ||
                b.batchId !== p.batchId ||
                b.registration !== l.state.key ||
                b.previousRunId !== l.state.runId ||
                b.definitionId !== p.definitionId ||
                b.reason !== p.reason ||
                b.position !== p.basis.recordedPosition ||
                !finite(b.sourcePosition) ||
                b.sourcePosition > b.position ||
                (b.deadline !== null && (!finite(b.deadline) || b.deadline <= b.basis.validAt)) ||
                canonical(b.basis) !== canonical(p.basis) ||
                canonical(b.before) !== canonical(l.state.candidates) ||
                !candidatesValid(l.state.name, b.before) ||
                !candidatesValid(l.state.name, b.after)
              )
                throw new Error("Invalid delivery payload");
              return b;
            },
            catch: (cause) => error("CorruptState", "Malformed delivery payload", cause),
          });
        });
      const verifySources = (candidates: readonly Derivation.Candidate[]) =>
        Effect.gen(function* () {
          const byEntity = new Map<string, Set<string>>();
          for (const c of candidates)
            for (const source of c.sources) {
              const ids = byEntity.get(source.entityId) ?? new Set<string>();
              ids.add(source.tripleId);
              byEntity.set(source.entityId, ids);
            }
          for (const [entity, ids] of byEntity) {
            const history = yield* store(t.history(unsafe.entityId(entity)));
            if ([...ids].some((id) => !history.some((row) => row.id === id)))
              return yield* error("CorruptState", "Required candidate source history is missing");
          }
        });
      for (const l of locals) {
        yield* verifySources(l.state.candidates);
        if (l.state.pending?.phase === "ready") {
          const payload = yield* payloadOf(l, l.state.pending);
          yield* verifySources([...payload.before, ...payload.after]);
        }
      }
      // Evaluation and delivery always reconcile against the acknowledged control snapshot.
      const finish = (l: Local): Effect.Effect<boolean, RunnerError, R> =>
        Effect.gen(function* () {
          let p = l.state.pending!;
          if (p.paused || (p.retryAt !== null && p.retryAt > (yield* Clock.currentTimeMillis)))
            return false;
          if (p.phase === "prepared") {
            const started = yield* Clock.currentTimeMillis;
            const definition = definitions.get(p.definitionId)!;
            const run = yield* permits.withPermits(1)(
              store(Materialization.materialize(t, definition, { basis: p.basis })),
            );
            evaluationTimeMs = Math.max(0, (yield* Clock.currentTimeMillis) - started);
            const payload: Payload = {
              version: 1,
              batchId: p.batchId,
              registration: l.state.key,
              definitionId: run.definitionId,
              configSnapshot: run.configSnapshot,
              previousRunId: l.state.runId,
              runId: run.id,
              position: p.basis.recordedPosition,
              sourcePosition: run.sourcePosition,
              basis: p.basis,
              reason: p.reason,
              before: l.state.candidates,
              after: run.candidates,
              deadline: run.nextTemporalBoundary ?? null,
            };
            const bytes = canonical(payload);
            if (
              run.candidates.length > maxCandidates ||
              new TextEncoder().encode(bytes).length > maxPayload
            ) {
              yield* update(l, {
                ...l.state,
                pending: { ...p, paused: true, failure: "PayloadLimit" },
              });
              return false;
            }
            p = { ...p, phase: "ready", payload: bytes };
            yield* update(l, { ...l.state, pending: p }, [
              Outbox.append({
                scope: root,
                idempotencyKey: p.batchId,
                payload: JSON.parse(bytes) as CanonicalValue,
              }),
            ]);
          }
          const b = yield* payloadOf(l, p);
          const diff = Derivation.reconcile(b.before, b.after);
          if (hasDiff(diff)) {
            p = { ...p, attempt: p.attempt + 1, cycleAttempt: p.cycleAttempt + 1, retryAt: null };
            yield* update(l, { ...l.state, pending: p });
            const delivery: Delivery = {
              version: 1,
              batchId: b.batchId,
              registration: b.registration,
              definitionId: b.definitionId,
              configSnapshot: b.configSnapshot,
              previousRunId: b.previousRunId,
              runId: b.runId,
              position: b.position,
              sourcePosition: b.sourcePosition,
              basis: b.basis,
              reason: b.reason,
              diff,
              attempt: p.attempt,
              commandId: (kind, id) => digest("command", [b.batchId, kind, id]),
            };
            const result = yield* Effect.result(l.registration.onDiff(freeze(delivery)));
            if (result._tag === "Failure") {
              l.failure = result.failure;
              const random = options.retry?.random?.() ?? Math.random();
              const delay =
                Math.min(maxDelay, initialDelay * 2 ** Math.min(p.cycleAttempt - 1, 30)) *
                (0.5 + Math.max(0, Math.min(1, random)) * 0.5);
              const retryAt = (yield* Clock.currentTimeMillis) + Math.ceil(delay);
              yield* update(l, {
                ...l.state,
                pending: {
                  ...p,
                  paused: p.cycleAttempt >= maxAttempts,
                  retryAt,
                  failure: "Handler failed",
                },
              });
              return false;
            }
          }
          yield* update(
            l,
            {
              ...l.state,
              definitionId: b.definitionId,
              configSnapshot: b.configSnapshot,
              runId: b.runId,
              headBatch: b.batchId,
              candidates: b.after,
              basis: b.basis,
              coverage: Math.max(l.state.coverage, b.position),
              frontier: Math.max(l.state.frontier, b.basis.validAt),
              deadline: b.deadline,
              pending: null,
            },
            [Outbox.acknowledge(Outbox.id(root, b.batchId))],
          );
          l.failure = null;
          return true;
        });
      let feedCache:
        | { after: number; page: import("../store/Triples.js").TransactionPage }
        | undefined;
      const readPage = (
        after: number,
      ): Effect.Effect<import("../store/Triples.js").TransactionPage, RunnerError> =>
        store(t.transactions({ after, limit: 1000 }));
      const feed = (after: number) =>
        Effect.gen(function* () {
          if (feedCache?.after === after) return feedCache.page;
          const page = yield* readPage(after);
          // Never cache an empty tail: another process can append after capture.
          if (page.transactions.length) feedCache = { after, page };
          return page;
        });
      const verifyGap = (after: number, before: number) =>
        Effect.gen(function* () {
          if (before <= after + 1) return;
          const metadata = yield* store(
            t.queryAll({
              find: ["?p"],
              where: [
                ["?tx", ":_tx/position", "?p"],
                [">", "?p", after],
                ["<", "?p", before],
              ],
            }),
          );
          if (metadata.results.length)
            return yield* error(
              "CorruptState",
              "Retained journal history is missing from the transaction feed",
            );
        });
      const process = (l: Local): Effect.Effect<void, RunnerError, R> =>
        Effect.gen(function* () {
          if (l.state.pending && !(yield* finish(l))) return;
          l.cursor = Math.max(l.cursor, l.state.coverage);
          const captured = head;
          if (l.state.definitionId !== l.registration.definition.id) {
            yield* prepare(
              l,
              {
                recordedPosition: captured,
                validAt: Math.max(l.state.frontier, yield* Clock.currentTimeMillis),
              },
              "definition",
            );
            if (!(yield* finish(l))) return;
            l.cursor = captured;
          }
          let turns = 0;
          const boundaries = (
            until: number,
            position: number,
            inclusive: boolean,
          ): Effect.Effect<boolean, RunnerError, R> =>
            Effect.gen(function* () {
              while (
                l.state.deadline !== null &&
                (inclusive ? l.state.deadline <= until : l.state.deadline < until)
              ) {
                if (++turns > 100) {
                  wake();
                  return false;
                }
                const at = l.state.deadline;
                timerLatenessMs = Math.max(0, (yield* Clock.currentTimeMillis) - at);
                yield* prepare(l, { recordedPosition: position, validAt: at }, "time");
                if (!(yield* finish(l))) return false;
                yield* Effect.yieldNow;
              }
              return true;
            });
          while (l.cursor < captured) {
            const page = yield* feed(l.cursor);
            const rows = page.transactions.filter((tx) => tx.position <= captured);
            if (!rows.length) {
              yield* verifyGap(l.cursor, captured + 1);
              l.cursor = captured;
              break;
            } // Unjournaled checkpoint positions are legitimate gaps.
            for (const tx of rows) {
              yield* verifyGap(l.cursor, tx.position);
              if (maintenance(tx)) {
                l.cursor = tx.position;
                continue;
              }
              const at = Math.max(l.state.frontier, tx.instant);
              if (!(yield* boundaries(at, l.cursor, false))) return;
              const due = l.state.deadline !== null && l.state.deadline <= at;
              if (relevant(l.registration.definition, tx) || due) {
                yield* prepare(l, { recordedPosition: tx.position, validAt: at }, "commit");
                if (!(yield* finish(l))) return;
              } else yield* update(l, { ...l.state, coverage: tx.position, frontier: at });
              l.cursor = tx.position;
            }
            yield* Effect.yieldNow;
          }
          if (
            !(yield* boundaries(
              Math.max(l.state.frontier, yield* Clock.currentTimeMillis),
              captured,
              true,
            ))
          )
            return;
          yield* advanceCheckpoint;
        });
      const fibers = new Set<Fiber.Fiber<void, RunnerError>>();
      const launch = (l: Local) =>
        Effect.gen(function* () {
          if (l.busy || stopped) return;
          l.busy = true;
          const work = process(l).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                l.busy = false;
                wake();
              }),
            ),
            Effect.onExit((exit) =>
              exit._tag === "Failure"
                ? Effect.sync(() => {
                    Deferred.doneUnsafe(fatal, Effect.failCause(exit.cause));
                  })
                : Effect.void,
            ),
          );
          const fiber = yield* Effect.forkScoped(work);
          fibers.add(fiber);
          for (const f of fibers) if (f.pollUnsafe() !== undefined) fibers.delete(f);
        });
      const coordinator = Effect.gen(function* () {
        while (!stopped) {
          // Capture the wake signal before reading the head: a commit or finished
          // delivery that wakes the runner during the reads below must not be lost.
          const signal = pulse;
          head = yield* store(t.currentPosition());
          scannedPosition = head;
          const launchTime = yield* Clock.currentTimeMillis;
          for (const l of locals) {
            const p = l.state.pending;
            if (
              p
                ? !p.paused && (p.retryAt === null || p.retryAt <= launchTime)
                : l.cursor < head ||
                  l.state.definitionId !== l.registration.definition.id ||
                  (l.state.deadline !== null && l.state.deadline <= launchTime)
            )
              yield* launch(l);
          }
          const time = yield* Clock.currentTimeMillis;
          const deadlines = locals.flatMap((l) =>
            l.busy
              ? []
              : l.state.pending
                ? l.state.pending.paused
                  ? []
                  : [l.state.pending.retryAt ?? time]
                : l.state.deadline === null
                  ? []
                  : [l.state.deadline],
          );
          const deadline = deadlines.length ? Math.min(...deadlines) : Infinity;
          yield* Effect.raceFirst(
            Effect.sleep(Math.max(1, Math.min(idle, deadline - time))),
            Deferred.await(signal),
          );
        }
      }).pipe(
        Effect.onExit((exit) =>
          exit._tag === "Failure"
            ? Effect.sync(() => {
                Deferred.doneUnsafe(fatal, Effect.failCause(exit.cause));
              })
            : Effect.void,
        ),
      );
      const coordinatorFiber = yield* Effect.forkScoped(coordinator);
      const stop = Effect.gen(function* () {
        stopped = true;
        yield* Fiber.interrupt(coordinatorFiber);
        for (const f of fibers) yield* Fiber.interrupt(f);
        releaseOwner();
      });
      yield* Effect.addFinalizer(() => stop);
      return {
        await: Deferred.await(fatal),
        stop,
        status: Effect.sync(() => ({
          consumer,
          scannedPosition,
          deliveredPosition: checkpoint,
          lag: Math.max(0, head - checkpoint),
          evaluationTimeMs,
          timerLatenessMs,
          registrations: locals.map((l) => ({
            key: l.state.key,
            deliveredPosition: l.state.coverage,
            acknowledgedRun: l.state.runId,
            pending: l.state.pending
              ? {
                  batchId: l.state.pending.batchId,
                  attempt: l.state.pending.attempt,
                  paused: l.state.pending.paused,
                  retryAt: l.state.pending.retryAt,
                  error: l.failure ?? l.state.pending.failure,
                }
              : null,
            nextDeadline: l.state.deadline,
          })),
        })),
        retryPaused: (key: string) =>
          locks.withPermits(1)(
            Effect.gen(function* () {
              const l = locals.find((l) => l.state.key === key);
              if (!l) return yield* error("Options", `Unknown registration ${key}`);
              if (l.state.pending?.paused)
                yield* update(l, {
                  ...l.state,
                  pending: {
                    ...l.state.pending,
                    paused: false,
                    cycleAttempt: 0,
                    retryAt: null,
                    failure: null,
                  },
                });
              wake();
            }),
          ),
      } satisfies Handle<E>;
    }).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Failure" ? Effect.sync(acquisitionCleanup) : Effect.void,
      ),
    );
  });
