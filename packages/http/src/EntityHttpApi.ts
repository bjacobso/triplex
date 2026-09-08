import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/unstable/httpapi";

import type { ConfigApiDescriptor, EntityDescriptor } from "./ConfigApi.js";
import { inputSchema, outputSchema } from "./EntityCodec.js";

export interface CompiledEntityHttpApi {
  readonly api: HttpApi.HttpApi<string, any>;
  readonly openApi: ReturnType<typeof OpenApi.fromApi>;
}

const ErrorBody = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  path: Schema.optional(Schema.String),
}).annotate({ identifier: "TriplexHttpError" });

const snapshotHeaders = { "x-triplex-config-snapshot": Schema.String };

const errors = [
  HttpApiSchema.WithHeaders(ErrorBody.pipe(HttpApiSchema.status(400)), snapshotHeaders),
  HttpApiSchema.WithHeaders(ErrorBody.pipe(HttpApiSchema.status(401)), snapshotHeaders),
  HttpApiSchema.WithHeaders(ErrorBody.pipe(HttpApiSchema.status(403)), snapshotHeaders),
  HttpApiSchema.WithHeaders(ErrorBody.pipe(HttpApiSchema.status(404)), snapshotHeaders),
  HttpApiSchema.WithHeaders(ErrorBody.pipe(HttpApiSchema.status(405)), {
    ...snapshotHeaders,
    allow: Schema.String,
  }),
  HttpApiSchema.WithHeaders(ErrorBody.pipe(HttpApiSchema.status(409)), snapshotHeaders),
  HttpApiSchema.WithHeaders(ErrorBody.pipe(HttpApiSchema.status(500)), snapshotHeaders),
] as const;

const query = {
  limit: Schema.optional(Schema.Int),
  cursor: Schema.optional(Schema.String),
  recordedAt: Schema.optional(Schema.Number),
  validAt: Schema.optional(Schema.Number),
};

const withSnapshotHeader = (schema: Schema.Top) =>
  HttpApiSchema.WithHeaders(schema, snapshotHeaders);

const entityGroup = (entity: EntityDescriptor, prefix: string, writable: boolean): any => {
  let group: any = HttpApiGroup.make(entity.entityType);
  const output = outputSchema(entity);
  if (entity.operations.includes("read")) {
    group = group.add(
      HttpApiEndpoint.get("list", "/", {
        query,
        success: withSnapshotHeader(
          Schema.Struct({
            items: Schema.Array(output),
            nextCursor: Schema.optional(Schema.String),
          }),
        ),
        error: errors,
      }),
      HttpApiEndpoint.get("get", "/:id", {
        params: { id: Schema.String },
        query: {
          recordedAt: Schema.optional(Schema.Number),
          validAt: Schema.optional(Schema.Number),
        },
        success: withSnapshotHeader(output),
        error: errors,
      }),
    );
  }
  if (writable && entity.operations.includes("create")) {
    group = group.add(
      HttpApiEndpoint.post("create", "/", {
        payload: inputSchema(entity),
        success: HttpApiSchema.WithHeaders(output.pipe(HttpApiSchema.status(201)), {
          location: Schema.String,
          ...snapshotHeaders,
        }),
        error: errors,
      }),
    );
  }
  if (writable && entity.operations.includes("replace")) {
    group = group.add(
      HttpApiEndpoint.put("replace", "/:id", {
        params: { id: Schema.String },
        payload: inputSchema(entity),
        success: withSnapshotHeader(output),
        error: errors,
      }),
    );
  }
  if (writable && entity.operations.includes("delete")) {
    group = group.add(
      HttpApiEndpoint.delete("delete", "/:id", {
        params: { id: Schema.String },
        success: withSnapshotHeader(HttpApiSchema.NoContent),
        error: errors,
      }),
    );
  }
  return group.prefix(`${prefix}/${entity.collection}` as `/${string}`).annotateMerge(
    OpenApi.annotations({
      title: entity.entityType,
      description: `Configuration-derived ${entity.entityType} collection`,
    }),
  );
};

export const compileHttpApi = (
  config: ConfigApiDescriptor,
  options: {
    readonly basePath: string;
    readonly version: string;
    readonly writable?: boolean;
    readonly docs?: boolean;
  },
): CompiledEntityHttpApi => {
  const prefix = `${options.basePath}/rest/${options.version}`;
  const writable = options.writable ?? true;
  const schemaResponse = Schema.Struct({
    protocolVersion: Schema.Literal(1),
    snapshotId: Schema.String,
    label: Schema.String,
    entities: Schema.Array(Schema.Unknown),
    constraints: Schema.Array(Schema.Unknown),
  }).annotate({ identifier: "TriplexConfigurationSchema" });
  let system: any = HttpApiGroup.make("triplexMeta").add(
    HttpApiEndpoint.get("schema", `${prefix}/schema` as `/${string}`, {
      success: withSnapshotHeader(schemaResponse),
      error: errors,
    }),
    HttpApiEndpoint.get("openapi", `${prefix}/openapi.json` as `/${string}`, {
      success: withSnapshotHeader(Schema.Unknown),
      error: errors,
    }),
  );
  if (options.docs === true) {
    system = system.add(
      HttpApiEndpoint.get("docs", `${prefix}/docs` as `/${string}`, {
        success: withSnapshotHeader(Schema.String.pipe(HttpApiSchema.asText())),
        error: errors,
      }),
    );
  }
  system = system.annotateMerge(OpenApi.annotations({ title: "Triplex configuration" }));
  let api: HttpApi.HttpApi<string, any> = HttpApi.make("triplex-entity-api")
    .add(system)
    .annotateMerge(
      OpenApi.annotations({
        title: "Triplex entity API",
        version: String(config.protocolVersion),
        description: `Derived from immutable configuration snapshot ${config.snapshotId}`,
      }),
    ) as unknown as HttpApi.HttpApi<string, any>;
  for (const entity of config.entities) {
    api = api.add(entityGroup(entity, prefix, writable)) as HttpApi.HttpApi<string, any>;
  }
  return { api, openApi: OpenApi.fromApi(api) };
};
