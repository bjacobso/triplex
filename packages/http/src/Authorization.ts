import { Context, Effect, Layer } from "effect";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";

import type { AuthorizationError } from "./Errors.js";

export type HttpOperation =
  | "schema"
  | "openapi"
  | "docs"
  | "list"
  | "read"
  | "create"
  | "replace"
  | "delete";

export interface AuthorizationInput {
  readonly operation: HttpOperation;
  readonly snapshotId: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly request: HttpServerRequest;
}

export interface HttpAuthorizationService {
  readonly authorize: (input: AuthorizationInput) => Effect.Effect<void, AuthorizationError>;
  /** Collection reads call this for every result, allowing host-owned row scoping. */
  readonly canReadEntity: (
    input: AuthorizationInput & { readonly entityId: string },
  ) => Effect.Effect<boolean, AuthorizationError>;
  /** Trusted mutation metadata. Payloads never control these fields. */
  readonly actor: (
    request: HttpServerRequest,
  ) => Effect.Effect<string | undefined, AuthorizationError>;
}

export class HttpAuthorization extends Context.Service<
  HttpAuthorization,
  HttpAuthorizationService
>()("triplex-http/HttpAuthorization") {}

export const layerAllowAll: Layer.Layer<HttpAuthorization> = Layer.succeed(HttpAuthorization, {
  authorize: () => Effect.void,
  canReadEntity: () => Effect.succeed(true),
  actor: () => Effect.succeed(undefined),
});
