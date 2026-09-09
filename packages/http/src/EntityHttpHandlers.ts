import {
  CommandAlreadyCommittedError,
  ConstraintViolationError,
  TransactionConflictError,
} from "@bjacobso/triplex";
import { Cause, Effect, Encoding, Result } from "effect";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiScalar } from "effect/unstable/httpapi";

import { HttpAuthorization } from "./Authorization.js";
import {
  compile,
  type ConfigApiDescriptor,
  type EntityDescriptor,
  type ExposureOptions,
} from "./ConfigApi.js";
import {
  CursorConflictError,
  DataShapeConflictError,
  EntityNotFoundHttpError,
  ForbiddenError,
  ReadOnlyVersionError,
  RequestValidationError,
  ScheduledFactsConflictError,
  UnauthorizedError,
  VersionNotFoundError,
} from "./Errors.js";
import { HandlerCache } from "./HandlerCache.js";
import { compileHttpApi, type CompiledEntityHttpApi } from "./EntityHttpApi.js";
import { EntityStore } from "./EntityStore.js";
import { VersionResolver } from "./VersionResolver.js";

export interface HandlerOptions {
  readonly basePath: string;
  readonly exposure?: ExposureOptions;
  readonly docs?: boolean;
}

interface CompiledRequestApi {
  readonly config: ConfigApiDescriptor;
  readonly contract: CompiledEntityHttpApi;
}

const temporalBasis = (url: URL) => {
  const value = (name: "recordedAt" | "validAt"): number | undefined => {
    const raw = url.searchParams.get(name);
    if (raw === null) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new RequestValidationError({
        code: "invalid_request",
        path: `$.${name}`,
        message: `${name} must be a non-negative epoch-millisecond instant`,
      });
    }
    return parsed;
  };
  const recordedAt = value("recordedAt");
  const validAt = value("validAt");
  if (recordedAt === undefined && validAt === undefined) return undefined;
  return {
    ...(recordedAt === undefined ? {} : { recordedAt }),
    ...(validAt === undefined ? {} : { validAt }),
  };
};

const listLimit = (url: URL): number | undefined => {
  const raw = url.searchParams.get("limit");
  if (raw === null) return undefined;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new RequestValidationError({
      code: "invalid_request",
      path: "$.limit",
      message: "limit must be an integer between 1 and 200",
    });
  }
  return limit;
};

const jsonError = (
  status: number,
  code: string,
  message: string,
  options: { readonly path?: string; readonly allow?: string } = {},
) =>
  HttpServerResponse.jsonUnsafe(
    { code, message, ...(options.path === undefined ? {} : { path: options.path }) },
    {
      status,
      headers: options.allow === undefined ? undefined : { allow: options.allow },
    },
  );

const mapError = (error: unknown) => {
  if (error instanceof RequestValidationError)
    return jsonError(400, error.code, error.message, { path: error.path });
  if (error instanceof UnauthorizedError) return jsonError(401, error.code, error.message);
  if (error instanceof ForbiddenError) return jsonError(403, error.code, error.message);
  if (error instanceof VersionNotFoundError) return jsonError(404, error.code, error.message);
  if (error instanceof EntityNotFoundHttpError) return jsonError(404, error.code, error.message);
  if (error instanceof ReadOnlyVersionError)
    return jsonError(405, error.code, error.message, { allow: error.allow });
  if (error instanceof DataShapeConflictError)
    return jsonError(409, error.code, error.message, { path: error.path });
  if (error instanceof ScheduledFactsConflictError)
    return jsonError(409, error.code, error.message);
  if (error instanceof CursorConflictError) return jsonError(409, error.code, error.message);
  if (error instanceof ConstraintViolationError)
    return jsonError(
      409,
      "constraint_violation",
      error.message,
      error.violations[0]?.path === undefined ? {} : { path: error.violations[0].path },
    );
  if (error instanceof TransactionConflictError)
    return jsonError(409, "transaction_conflict", error.message);
  if (error instanceof CommandAlreadyCommittedError)
    return jsonError(409, "command_already_committed", error.message);
  return jsonError(500, "internal_error", "The request could not be completed");
};

const withSnapshot = <A extends ReturnType<typeof HttpServerResponse.jsonUnsafe>>(
  response: A,
  snapshot: string,
): A => HttpServerResponse.setHeader(response, "x-triplex-config-snapshot", snapshot) as A;

const rejectWriteTemporal = (url: URL) => {
  if (url.searchParams.has("recordedAt") || url.searchParams.has("validAt")) {
    throw new RequestValidationError({
      code: "invalid_request",
      path: "$",
      message: "recordedAt and validAt are read-only parameters",
    });
  }
};

const requestJson = (request: HttpServerRequest) =>
  request.json.pipe(
    Effect.mapError(
      (error) =>
        new RequestValidationError({
          code: "invalid_request",
          path: "$",
          message: `Request body must be valid JSON: ${error.message}`,
        }),
    ),
  );

const scalarDocs = (request: HttpServerRequest, api: CompiledEntityHttpApi["api"], path: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(HttpApiScalar.layer(api, { path: path as `/${string}` }), {
        disableLogger: true,
      }),
    ),
    (web) =>
      Effect.promise(() =>
        web.handler(new Request(new URL(request.url, "http://triplex.invalid"), { method: "GET" })),
      ).pipe(Effect.map(HttpServerResponse.fromWeb)),
    (web) => Effect.promise(() => web.dispose()),
  );

const operationAllow = (
  entity: EntityDescriptor,
  target: "collection" | "entity",
  writable: boolean,
): string => {
  const methods = new Set<string>();
  if (entity.operations.includes("read")) methods.add("GET");
  if (writable && target === "collection" && entity.operations.includes("create")) {
    methods.add("POST");
  }
  if (writable && target === "entity" && entity.operations.includes("replace")) {
    methods.add("PUT");
  }
  if (writable && target === "entity" && entity.operations.includes("delete")) {
    methods.add("DELETE");
  }
  return [...methods].join(", ");
};

const cursorEncoder = new TextEncoder();
const cursorDecoder = new TextDecoder();

const encodeCursor = (input: {
  readonly cursor: string;
  readonly snapshotId: string;
  readonly exposureKey: string;
  readonly collection: string;
}): string =>
  Encoding.encodeBase64Url(cursorEncoder.encode(JSON.stringify({ version: 1, ...input })));

const decodeCursor = (
  cursor: string,
  expected: {
    readonly snapshotId: string;
    readonly exposureKey: string;
    readonly collection: string;
  },
): string => {
  try {
    const bytes = Encoding.decodeBase64Url(cursor);
    if (Result.isFailure(bytes)) throw bytes.failure;
    const value: unknown = JSON.parse(cursorDecoder.decode(bytes.success));
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      value.version !== 1 ||
      !("cursor" in value) ||
      typeof value.cursor !== "string" ||
      !("snapshotId" in value) ||
      typeof value.snapshotId !== "string" ||
      !("exposureKey" in value) ||
      typeof value.exposureKey !== "string" ||
      !("collection" in value) ||
      typeof value.collection !== "string"
    ) {
      throw new Error("invalid cursor shape");
    }
    if (
      value.snapshotId !== expected.snapshotId ||
      value.exposureKey !== expected.exposureKey ||
      value.collection !== expected.collection
    ) {
      throw new CursorConflictError({
        code: "cursor_conflict",
        message: "The collection cursor belongs to a different configuration; restart pagination",
      });
    }
    return value.cursor;
  } catch (error) {
    if (error instanceof CursorConflictError) throw error;
    throw new RequestValidationError({
      code: "invalid_request",
      path: "$.cursor",
      message: "cursor must be a valid Triplex collection cursor",
    });
  }
};

export const handle = (request: HttpServerRequest, options: HandlerOptions) => {
  let responseSnapshot: string | undefined;
  return Effect.gen(function* () {
    const resolver = yield* VersionResolver;
    const cache = yield* HandlerCache;
    const store = yield* EntityStore;
    const authorization = yield* HttpAuthorization;
    const url = new URL(request.url, "http://triplex.invalid");
    const restPrefix = `${options.basePath}/rest/`;
    if (!url.pathname.startsWith(restPrefix)) {
      return jsonError(404, "not_found", "Route not found");
    }
    const path = url.pathname.slice(restPrefix.length).split("/");
    let segments: string[];
    try {
      segments = path.map(decodeURIComponent);
    } catch {
      return jsonError(400, "invalid_request", "Path contains invalid percent encoding");
    }
    const version = segments.shift();
    if (version === undefined || version.length === 0) {
      return jsonError(404, "version_not_found", "Configuration version is missing");
    }
    const resolved = yield* resolver.resolve(version);
    const snapshotId = resolved.snapshot.id;
    responseSnapshot = snapshotId;
    const exposureKey = JSON.stringify(options.exposure ?? {});
    const compiled = yield* cache.get(
      `${resolved.snapshot.id}\u0000${exposureKey}\u0000${options.basePath}\u0000${version}\u0000${resolved.writable}`,
      compile(resolved.snapshot, options.exposure).pipe(
        Effect.flatMap((config) =>
          Effect.try({
            try: (): CompiledRequestApi => ({
              config,
              contract: compileHttpApi(config, {
                basePath: options.basePath,
                version,
                writable: resolved.writable,
                ...(options.docs === undefined ? {} : { docs: options.docs }),
              }),
            }),
            catch: (error) => error,
          }),
        ),
      ),
    );
    const authorize = (
      operation: Parameters<typeof authorization.authorize>[0]["operation"],
      entity?: EntityDescriptor,
      entityId?: string,
    ) =>
      authorization.authorize({
        operation,
        snapshotId,
        request,
        ...(entity === undefined ? {} : { entityType: entity.entityType }),
        ...(entityId === undefined ? {} : { entityId }),
      });
    const tail = segments.filter(
      (segment, index) => segment.length > 0 || index < segments.length - 1,
    );
    const first = tail[0];
    if (request.method === "GET" && first === "schema" && tail.length === 1) {
      yield* authorize("schema");
      return withSnapshot(HttpServerResponse.jsonUnsafe(compiled.config), snapshotId);
    }
    if (request.method === "GET" && first === "openapi.json" && tail.length === 1) {
      yield* authorize("openapi");
      return withSnapshot(HttpServerResponse.jsonUnsafe(compiled.contract.openApi), snapshotId);
    }
    if (
      request.method === "GET" &&
      first === "docs" &&
      tail.length === 1 &&
      options.docs === true
    ) {
      yield* authorize("docs");
      return withSnapshot(
        yield* scalarDocs(request, compiled.contract.api, url.pathname),
        snapshotId,
      );
    }
    const entity = compiled.config.entities.find((candidate) => candidate.collection === first);
    if (entity === undefined) {
      yield* authorize("schema");
      return withSnapshot(
        jsonError(404, "collection_not_found", "Collection not found"),
        snapshotId,
      );
    }
    const rawId = tail[1];
    if (tail.length > 2) {
      yield* authorize("schema");
      return withSnapshot(jsonError(404, "not_found", "Route not found"), snapshotId);
    }

    if (request.method === "GET" && rawId === undefined && entity.operations.includes("read")) {
      yield* authorize("list", entity);
      const limit = listLimit(url);
      const rawCursor = url.searchParams.get("cursor");
      const basis = temporalBasis(url);
      const page = yield* store.list(entity, {
        ...(limit === undefined ? {} : { limit }),
        ...(rawCursor === null
          ? {}
          : {
              cursor: decodeCursor(rawCursor, {
                snapshotId,
                exposureKey,
                collection: entity.collection,
              }),
            }),
        ...(basis === undefined ? {} : { basis }),
      });
      const items = yield* Effect.filter(page.items, (item) =>
        authorization.canReadEntity({
          operation: "read",
          snapshotId,
          request,
          entityType: entity.entityType,
          entityId: item.id,
        }),
      );
      return withSnapshot(
        HttpServerResponse.jsonUnsafe({
          items,
          ...(page.nextCursor === undefined
            ? {}
            : {
                nextCursor: encodeCursor({
                  cursor: page.nextCursor,
                  snapshotId,
                  exposureKey,
                  collection: entity.collection,
                }),
              }),
        }),
        snapshotId,
      );
    }
    if (request.method === "GET" && rawId !== undefined && entity.operations.includes("read")) {
      yield* authorize("read", entity, rawId);
      return withSnapshot(
        HttpServerResponse.jsonUnsafe(yield* store.get(entity, rawId, temporalBasis(url))),
        snapshotId,
      );
    }
    if (request.method === "POST" && rawId === undefined && entity.operations.includes("create")) {
      yield* authorize("create", entity);
      if (!resolved.writable)
        return yield* new ReadOnlyVersionError({
          code: "read_only_version",
          allow: operationAllow(entity, "collection", false),
          message: "This configuration version is read-only",
        });
      rejectWriteTemporal(url);
      const actor = yield* authorization.actor(request);
      const document = yield* store.create(
        compiled.config,
        entity,
        yield* requestJson(request),
        actor === undefined ? {} : { actor },
      );
      return withSnapshot(
        HttpServerResponse.jsonUnsafe(document, {
          status: 201,
          headers: {
            location: `${options.basePath}/rest/${version}/${entity.collection}/${encodeURIComponent(document.id)}`,
          },
        }),
        snapshotId,
      );
    }
    if (request.method === "PUT" && rawId !== undefined && entity.operations.includes("replace")) {
      yield* authorize("replace", entity, rawId);
      if (!resolved.writable)
        return yield* new ReadOnlyVersionError({
          code: "read_only_version",
          allow: operationAllow(entity, "entity", false),
          message: "This configuration version is read-only",
        });
      rejectWriteTemporal(url);
      const actor = yield* authorization.actor(request);
      const document = yield* store.replace(
        compiled.config,
        entity,
        rawId,
        yield* requestJson(request),
        actor === undefined ? {} : { actor },
      );
      return withSnapshot(HttpServerResponse.jsonUnsafe(document), snapshotId);
    }
    if (
      request.method === "DELETE" &&
      rawId !== undefined &&
      entity.operations.includes("delete")
    ) {
      yield* authorize("delete", entity, rawId);
      if (!resolved.writable)
        return yield* new ReadOnlyVersionError({
          code: "read_only_version",
          allow: operationAllow(entity, "entity", false),
          message: "This configuration version is read-only",
        });
      rejectWriteTemporal(url);
      const actor = yield* authorization.actor(request);
      yield* store.delete(compiled.config, entity, rawId, actor === undefined ? {} : { actor });
      return withSnapshot(HttpServerResponse.empty({ status: 204 }), snapshotId);
    }
    const deniedOperation =
      request.method === "POST" && rawId === undefined
        ? "create"
        : request.method === "PUT" && rawId !== undefined
          ? "replace"
          : request.method === "DELETE" && rawId !== undefined
            ? "delete"
            : rawId === undefined
              ? "list"
              : "read";
    yield* authorize(deniedOperation, entity, rawId);
    return withSnapshot(
      jsonError(405, "method_not_allowed", "Method not allowed", {
        allow: operationAllow(
          entity,
          rawId === undefined ? "collection" : "entity",
          resolved.writable,
        ),
      }),
      snapshotId,
    );
  }).pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      return Effect.logError("Triplex HTTP request failed", error).pipe(
        Effect.as(
          responseSnapshot === undefined
            ? mapError(error)
            : withSnapshot(mapError(error), responseSnapshot),
        ),
      );
    }),
  );
};
