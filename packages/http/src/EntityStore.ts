import {
  EntityId,
  PaginationCursorError,
  Triples,
  type TemporalBasis,
  type TransactionMeta,
  type Triple,
  type TransactOp,
} from "@triplex-build/triplex";
import { Clock, Context, Effect, Layer, Option } from "effect";
import { ulid } from "ulidx";

import type { ConfigApiDescriptor, EntityDescriptor } from "./ConfigApi.js";
import { decodeInput, encodeEntity, type EntityDocument } from "./EntityCodec.js";
import {
  EntityNotFoundHttpError,
  RequestValidationError,
  ScheduledFactsConflictError,
} from "./Errors.js";

export interface EntityListPage {
  readonly items: ReadonlyArray<EntityDocument>;
  readonly nextCursor?: string;
}

export interface MutationContext {
  readonly actor?: string;
  readonly commandId?: string;
}

export interface EntityStoreService {
  readonly list: (
    entity: EntityDescriptor,
    request: { readonly limit?: number; readonly cursor?: string; readonly basis?: TemporalBasis },
  ) => Effect.Effect<EntityListPage, unknown>;
  readonly get: (
    entity: EntityDescriptor,
    id: string,
    basis?: TemporalBasis,
  ) => Effect.Effect<EntityDocument, unknown>;
  readonly create: (
    config: ConfigApiDescriptor,
    entity: EntityDescriptor,
    body: unknown,
    context?: MutationContext,
  ) => Effect.Effect<EntityDocument, unknown>;
  readonly replace: (
    config: ConfigApiDescriptor,
    entity: EntityDescriptor,
    id: string,
    body: unknown,
    context?: MutationContext,
  ) => Effect.Effect<EntityDocument, unknown>;
  readonly delete: (
    config: ConfigApiDescriptor,
    entity: EntityDescriptor,
    id: string,
    context?: MutationContext,
  ) => Effect.Effect<void, unknown>;
}

export class EntityStore extends Context.Service<EntityStore, EntityStoreService>()(
  "triplex-http/EntityStore",
) {}

const notFound = (id: string) =>
  new EntityNotFoundHttpError({
    code: "entity_not_found",
    entityId: id,
    message: `Entity ${id} was not found in this collection`,
  });

const hasMembership = (facts: readonly Triple[], entityType: string): boolean =>
  facts.some((fact) => Option.isSome(fact.entityType) && fact.entityType.value === entityType);

const assertOperations = (
  id: ReturnType<typeof EntityId.make>,
  entity: EntityDescriptor,
  values: ReadonlyMap<
    import("./ConfigApi.js").AttributeDescriptor,
    ReadonlyArray<import("@triplex-build/triplex").TripleValue>
  >,
): ReadonlyArray<TransactOp> =>
  [...values].flatMap(([attribute, facts]) =>
    facts.map(
      (value): TransactOp => ({
        op: "assert",
        entityId: id,
        entityType: entity.entityType,
        attribute: attribute.key,
        value,
      }),
    ),
  );

const transactionMeta = (
  config: ConfigApiDescriptor,
  context: MutationContext | undefined,
  preconditions?: TransactionMeta["preconditions"],
): TransactionMeta => ({
  configSnapshot: config.snapshotId,
  enforce: { constraints: config.constraints },
  ...(context?.actor === undefined ? {} : { actor: context.actor }),
  ...(context?.commandId === undefined ? {} : { commandId: context.commandId }),
  ...(preconditions === undefined ? {} : { preconditions }),
});

const rejectScheduledFacts = (
  triples: import("@triplex-build/triplex").TriplesService,
  id: ReturnType<typeof EntityId.make>,
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const history = yield* triples.history(id);
    if (history.some((fact) => fact.validFrom > now && Option.isNone(fact.retractedAt))) {
      return yield* new ScheduledFactsConflictError({
        code: "scheduled_facts",
        entityId: id,
        message: `Entity ${id} has scheduled future facts and cannot be mutated by the initial REST contract`,
      });
    }
  });

const make = Effect.gen(function* () {
  const triples = yield* Triples;

  return {
    list: (entity, request) =>
      triples
        .entityPage({
          entityType: entity.entityType,
          ...(request.limit === undefined ? {} : { limit: request.limit }),
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          ...(request.basis === undefined ? {} : { basis: request.basis }),
        })
        .pipe(
          Effect.flatMap((page) =>
            Effect.forEach(page.entities, (facts) => encodeEntity(entity, facts)).pipe(
              Effect.map((items) => ({
                items,
                ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
              })),
            ),
          ),
          Effect.mapError((error) =>
            error instanceof PaginationCursorError
              ? new RequestValidationError({
                  code: "invalid_request",
                  path: "$.cursor",
                  message: error.message,
                })
              : error,
          ),
        ),

    get: (entity, rawId, basis) =>
      Effect.gen(function* () {
        const id = yield* EntityId.decode(rawId).pipe(
          Effect.mapError(
            (error) =>
              new RequestValidationError({
                code: "invalid_request",
                path: "$.id",
                message: error.message,
              }),
          ),
        );
        const facts = yield* triples.entity(id, basis);
        if (facts.length === 0 || !hasMembership(facts, entity.entityType))
          return yield* notFound(id);
        return yield* encodeEntity(entity, facts);
      }),

    create: (config, entity, body, context) =>
      Effect.gen(function* () {
        const values = yield* decodeInput(entity, body);
        const id = EntityId.make(
          `${entity.entityType.slice(0, 1).toLowerCase()}${entity.entityType.slice(1)}:${ulid()}`,
        );
        const result = yield* triples.transact(
          assertOperations(id, entity, values),
          transactionMeta(config, context),
        );
        return yield* encodeEntity(entity, result.triples);
      }),

    replace: (config, entity, rawId, body, context) =>
      Effect.gen(function* () {
        const values = yield* decodeInput(entity, body);
        const id = yield* EntityId.decode(rawId).pipe(
          Effect.mapError(
            (error) =>
              new RequestValidationError({
                code: "invalid_request",
                path: "$.id",
                message: error.message,
              }),
          ),
        );
        yield* rejectScheduledFacts(triples, id);
        const current = yield* triples.entity(id);
        if (current.length === 0 || !hasMembership(current, entity.entityType)) {
          return yield* notFound(id);
        }
        yield* encodeEntity(entity, current);
        const exposed = new Set(entity.attributes.map((attribute) => attribute.key));
        const retracts: TransactOp[] = current
          .filter((fact) => exposed.has(fact.attribute))
          .map((fact) => ({ op: "retract", id: fact.id }));
        const result = yield* triples.transact(
          [...retracts, ...assertOperations(id, entity, values)],
          transactionMeta(config, context, [
            { _tag: "EntityState", entityId: id, tripleIds: current.map((fact) => fact.id) },
          ]),
        );
        return yield* encodeEntity(entity, result.triples);
      }),

    delete: (config, entity, rawId, context) =>
      Effect.gen(function* () {
        const id = yield* EntityId.decode(rawId).pipe(
          Effect.mapError(
            (error) =>
              new RequestValidationError({
                code: "invalid_request",
                path: "$.id",
                message: error.message,
              }),
          ),
        );
        yield* rejectScheduledFacts(triples, id);
        const current = yield* triples.entity(id);
        if (current.length === 0 || !hasMembership(current, entity.entityType)) {
          return yield* notFound(id);
        }
        yield* encodeEntity(entity, current);
        yield* triples.transact(
          current.map((fact) => ({ op: "retract" as const, id: fact.id })),
          transactionMeta(config, context, [
            { _tag: "EntityState", entityId: id, tripleIds: current.map((fact) => fact.id) },
          ]),
        );
      }),
  } satisfies EntityStoreService;
});

export const layer: Layer.Layer<EntityStore, never, Triples> = Layer.effect(EntityStore, make);
