import { Data, Effect, Schema } from "effect";
import {
  DatalogQuery,
  EntityId,
  QueryRequest,
  queryToPattern,
  TemporalBasis,
  TransactionId,
  TransactRequest,
  TripleId,
  Triples,
  WrappedQuery,
  type TriplesService,
  type QueryOptions as TriplesQueryOptions,
} from "@bjacobso/triplex";
import { InstanceIdentity, sameInstanceIdentity } from "./Identity.js";
import {
  StaleRouteError,
  TenantAuthorizer,
  type DatabaseOperation,
  type Principal,
} from "./Services.js";

export const DataOperation = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Transact"), request: TransactRequest }),
  Schema.Struct({ _tag: Schema.Literal("Get"), tripleId: TripleId }),
  Schema.Struct({
    _tag: Schema.Literal("Entity"),
    entityId: EntityId,
    basis: Schema.optional(TemporalBasis),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Match"),
    pattern: QueryRequest,
    basis: Schema.optional(TemporalBasis),
  }),
  Schema.Struct({ _tag: Schema.Literal("History"), entityId: EntityId }),
  Schema.Struct({
    _tag: Schema.Literal("Query"),
    query: DatalogQuery,
    options: Schema.optional(
      Schema.Struct({
        debug: Schema.optional(Schema.Boolean),
        basis: Schema.optional(TemporalBasis),
      }),
    ),
  }),
  Schema.Struct({
    _tag: Schema.Literal("QueryPage"),
    query: WrappedQuery,
    options: Schema.optional(
      Schema.Struct({
        debug: Schema.optional(Schema.Boolean),
        basis: Schema.optional(TemporalBasis),
      }),
    ),
  }),
  Schema.Struct({ _tag: Schema.Literal("Transaction"), transactionId: TransactionId }),
  Schema.Struct({ _tag: Schema.Literal("TransactionByCommand"), commandId: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("Transactions"),
    after: Schema.optional(Schema.Number),
    limit: Schema.optional(Schema.Number),
  }),
]);
export type DataOperation = typeof DataOperation.Type;

export const TenantDataRequest = Schema.Struct({
  version: Schema.Literal(1),
  identity: InstanceIdentity,
  routingRevision: Schema.Number.pipe(Schema.check(Schema.isInt())),
  operation: DataOperation,
});
export type TenantDataRequest = typeof TenantDataRequest.Type;

export class ProtocolDecodeError extends Data.TaggedError("ProtocolDecodeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const decodeTenantDataRequest = (
  input: unknown,
): Effect.Effect<TenantDataRequest, ProtocolDecodeError> =>
  Schema.decodeUnknownEffect(TenantDataRequest)(input).pipe(
    Effect.mapError(
      (cause) => new ProtocolDecodeError({ message: "Invalid Triplex host request", cause }),
    ),
  );

export const requiredOperation = (operation: DataOperation): DatabaseOperation =>
  operation._tag === "Transact" ? "write" : "read";

const queryOptions = (
  options:
    | {
        readonly debug?: boolean | undefined;
        readonly basis?:
          | {
              readonly recordedAt?: number | undefined;
              readonly validAt?: number | undefined;
            }
          | undefined;
      }
    | undefined,
): TriplesQueryOptions | undefined =>
  options === undefined
    ? undefined
    : {
        ...(options.debug === undefined ? {} : { debug: options.debug }),
        ...(options.basis === undefined
          ? {}
          : {
              basis: {
                ...(options.basis.recordedAt === undefined
                  ? {}
                  : { recordedAt: options.basis.recordedAt }),
                ...(options.basis.validAt === undefined ? {} : { validAt: options.basis.validAt }),
              },
            }),
      };

export const executeDataOperation = (
  triples: TriplesService,
  operation: DataOperation,
): Effect.Effect<unknown, unknown> => {
  switch (operation._tag) {
    case "Transact":
      return triples.transact(
        operation.request.operations,
        operation.request.meta === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(operation.request.meta).filter((entry) => entry[1] !== undefined),
            ),
      );
    case "Get":
      return triples.get(operation.tripleId);
    case "Entity":
      return triples.entity(operation.entityId, operation.basis);
    case "Match":
      return triples.match(queryToPattern(operation.pattern), operation.basis);
    case "History":
      return triples.history(operation.entityId);
    case "Query":
      return triples.query(operation.query, queryOptions(operation.options));
    case "QueryPage":
      return triples.queryPage(operation.query, queryOptions(operation.options));
    case "Transaction":
      return triples.transaction(operation.transactionId);
    case "TransactionByCommand":
      return triples.transactionByCommand(operation.commandId);
    case "Transactions":
      return triples.transactions({
        ...(operation.after === undefined ? {} : { after: operation.after }),
        ...(operation.limit === undefined ? {} : { limit: operation.limit }),
      });
  }
};

export interface BoundTenantInstance {
  readonly identity: InstanceIdentity;
  readonly routingRevision: number;
}

/**
 * Execute against an already-bound instance. Identity and routing revision are
 * verified again at the target before authorization and database access.
 */
export const executeTenantDataRequest = (
  binding: BoundTenantInstance,
  principal: Principal,
  request: TenantDataRequest,
): Effect.Effect<unknown, unknown, Triples | TenantAuthorizer> =>
  Effect.gen(function* () {
    if (
      !sameInstanceIdentity(binding.identity, request.identity) ||
      binding.routingRevision !== request.routingRevision
    ) {
      return yield* Effect.fail(
        new StaleRouteError({ message: "Instance identity or routing revision does not match" }),
      );
    }
    const authorizer = yield* TenantAuthorizer;
    yield* authorizer.authorize({
      principal,
      identity: binding.identity,
      operation: requiredOperation(request.operation),
    });
    const triples = yield* Triples;
    return yield* executeDataOperation(triples, request.operation);
  });
