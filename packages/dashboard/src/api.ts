import { TemporalBasis, Triples, type TemporalBasis as TemporalBasisType } from "@bjacobso/triplex";
import { ConfigStore } from "@bjacobso/triplex/config";
import { Context, Effect, Layer, Schema } from "effect";

import {
  executeQueryText,
  loadDashboardAt,
  loadEntityHistory,
  loadEntityTypePage,
  moveConfigRef,
  publishConfigChange,
  saveEntity,
  type PublishConfigChangeInput,
  type SaveEntityInput,
} from "./data.js";
import {
  DashboardData,
  EntityTypePageView,
  QueryView,
  TransactionView,
  type DashboardData as DashboardDataType,
  type EntityTypePageView as EntityTypePageViewType,
  type QueryView as QueryViewType,
  type TransactionView as TransactionViewType,
} from "./model.js";

const SaveEntityRequest = Schema.Struct({
  _tag: Schema.Literal("SaveEntity"),
  mode: Schema.Literals(["create", "edit"]),
  entityId: Schema.String,
  entityType: Schema.String,
  facts: Schema.String,
});

const PublishConfigRequest = Schema.Struct({
  _tag: Schema.Literal("PublishConfig"),
  operation: Schema.Literals(["create", "edit", "remove"]),
  identity: Schema.optional(Schema.String),
  kind: Schema.String,
  key: Schema.String,
  attrs: Schema.String,
  refs: Schema.String,
  label: Schema.String,
  targetRef: Schema.String,
});

export const DashboardRequest = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("LoadDashboard"),
    basis: Schema.optional(TemporalBasis),
  }),
  Schema.Struct({
    _tag: Schema.Literal("RunQuery"),
    source: Schema.String,
    basis: Schema.optional(TemporalBasis),
  }),
  Schema.Struct({
    _tag: Schema.Literal("LoadEntityTypePage"),
    entityType: Schema.String,
    cursor: Schema.NullOr(Schema.String),
    basis: Schema.optional(TemporalBasis),
  }),
  Schema.Struct({ _tag: Schema.Literal("LoadEntityHistory"), entityId: Schema.String }),
  SaveEntityRequest,
  PublishConfigRequest,
  Schema.Struct({
    _tag: Schema.Literal("MoveConfigRef"),
    name: Schema.String,
    snapshotId: Schema.String,
  }),
]);
export type DashboardRequest = typeof DashboardRequest.Type;

export interface DashboardApiService {
  readonly loadDashboard: (basis?: TemporalBasisType) => Effect.Effect<DashboardDataType, unknown>;
  readonly runQuery: (
    source: string,
    basis?: TemporalBasisType,
  ) => Effect.Effect<QueryViewType, unknown>;
  readonly loadEntityTypePage: (
    entityType: string,
    cursor: string | null,
    basis?: TemporalBasisType,
  ) => Effect.Effect<EntityTypePageViewType, unknown>;
  readonly loadEntityHistory: (
    entityId: string,
  ) => Effect.Effect<readonly TransactionViewType[], unknown>;
  readonly saveEntity: (input: SaveEntityInput) => Effect.Effect<string, unknown>;
  readonly publishConfig: (input: PublishConfigChangeInput) => Effect.Effect<string, unknown>;
  readonly moveConfigRef: (name: string, snapshotId: string) => Effect.Effect<string, unknown>;
}

export class DashboardApi extends Context.Service<DashboardApi, DashboardApiService>()(
  "triplex-dashboard/DashboardApi",
) {}

export const localDashboardApiLayer = (
  source: string,
): Layer.Layer<DashboardApi, never, Triples | ConfigStore.ConfigStore> =>
  Layer.effect(
    DashboardApi,
    Effect.gen(function* () {
      const triples = yield* Triples;
      const config = yield* ConfigStore.ConfigStore;
      const withTriples = <A, E>(effect: Effect.Effect<A, E, Triples>) =>
        effect.pipe(Effect.provideService(Triples, triples));
      const withDatabase = <A, E>(effect: Effect.Effect<A, E, Triples | ConfigStore.ConfigStore>) =>
        effect.pipe(
          Effect.provideService(Triples, triples),
          Effect.provideService(ConfigStore.ConfigStore, config),
        );
      const withConfig = <A, E>(effect: Effect.Effect<A, E, ConfigStore.ConfigStore>) =>
        effect.pipe(Effect.provideService(ConfigStore.ConfigStore, config));

      return DashboardApi.of({
        loadDashboard: (basis) => withDatabase(loadDashboardAt(basis, source)),
        runQuery: (querySource, basis) => withTriples(executeQueryText(querySource, basis)),
        loadEntityTypePage: (entityType, cursor, basis) =>
          withDatabase(loadEntityTypePage(entityType, cursor, 5, basis)),
        loadEntityHistory: (entityId) => withTriples(loadEntityHistory(entityId)),
        saveEntity: (input) => withTriples(saveEntity(input)),
        publishConfig: (input) => withConfig(publishConfigChange(input)),
        moveConfigRef: (name, snapshotId) => withConfig(moveConfigRef(name, snapshotId)),
      });
    }),
  );

export const executeDashboardRequest = (
  request: DashboardRequest,
): Effect.Effect<unknown, unknown, DashboardApi> =>
  Effect.gen(function* () {
    const api = yield* DashboardApi;
    switch (request._tag) {
      case "LoadDashboard":
        return yield* api.loadDashboard(request.basis);
      case "RunQuery":
        return yield* api.runQuery(request.source, request.basis);
      case "LoadEntityTypePage":
        return yield* api.loadEntityTypePage(request.entityType, request.cursor, request.basis);
      case "LoadEntityHistory":
        return yield* api.loadEntityHistory(request.entityId);
      case "SaveEntity":
        return yield* api.saveEntity(request);
      case "PublishConfig":
        return yield* api.publishConfig({
          operation: request.operation,
          ...(request.identity === undefined ? {} : { identity: request.identity }),
          kind: request.kind,
          key: request.key,
          attrs: request.attrs,
          refs: request.refs,
          label: request.label,
          targetRef: request.targetRef,
        });
      case "MoveConfigRef":
        return yield* api.moveConfigRef(request.name, request.snapshotId);
    }
  });

const RemoteEnvelope = Schema.Struct({
  ok: Schema.Boolean,
  value: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});

const remoteCall = <A>(
  baseUrl: string,
  request: DashboardRequest,
  response: Schema.Codec<A, unknown, never, never>,
): Effect.Effect<A, unknown> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: async () => {
        const httpResponse = await fetch(`${baseUrl}/api/dashboard`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        const json = (await httpResponse.json()) as unknown;
        if (!httpResponse.ok) throw json;
        return json;
      },
      catch: (cause) => cause,
    });
    const envelope = yield* Schema.decodeUnknownEffect(RemoteEnvelope)(result);
    if (!envelope.ok)
      return yield* Effect.fail(new Error(envelope.error ?? "Dashboard request failed"));
    return yield* Schema.decodeUnknownEffect(response)(envelope.value);
  });

export const remoteDashboardApiLayer = (baseUrl = ""): Layer.Layer<DashboardApi> =>
  Layer.succeed(
    DashboardApi,
    DashboardApi.of({
      loadDashboard: (basis) =>
        remoteCall(baseUrl, { _tag: "LoadDashboard", basis }, DashboardData),
      runQuery: (source, basis) =>
        remoteCall(baseUrl, { _tag: "RunQuery", source, basis }, QueryView),
      loadEntityTypePage: (entityType, cursor, basis) =>
        remoteCall(
          baseUrl,
          { _tag: "LoadEntityTypePage", entityType, cursor, basis },
          EntityTypePageView,
        ),
      loadEntityHistory: (entityId) =>
        remoteCall(baseUrl, { _tag: "LoadEntityHistory", entityId }, Schema.Array(TransactionView)),
      saveEntity: (input) => remoteCall(baseUrl, { _tag: "SaveEntity", ...input }, Schema.String),
      publishConfig: (input) =>
        remoteCall(baseUrl, { _tag: "PublishConfig", ...input }, Schema.String),
      moveConfigRef: (name, snapshotId) =>
        remoteCall(baseUrl, { _tag: "MoveConfigRef", name, snapshotId }, Schema.String),
    }),
  );
