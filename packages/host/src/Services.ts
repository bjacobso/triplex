import { Context, Data, Effect } from "effect";
import type { InstanceIdentity } from "./Identity.js";
import type { TenantRecord } from "./Lifecycle.js";

export const DatabaseOperation = ["read", "write", "admin"] as const;
export type DatabaseOperation = (typeof DatabaseOperation)[number];

export interface Principal {
  readonly subject: string;
  readonly claims?: Readonly<Record<string, unknown>>;
}

export class AuthorizationError extends Data.TaggedError("AuthorizationError")<{
  readonly message: string;
}> {}

export class InstanceNotFoundError extends Data.TaggedError("InstanceNotFoundError")<{
  readonly message: string;
}> {}

export class InstanceUnavailableError extends Data.TaggedError("InstanceUnavailableError")<{
  readonly state: TenantRecord["state"];
  readonly message: string;
}> {}

export class RegistryConflictError extends Data.TaggedError("RegistryConflictError")<{
  readonly expectedRevision: number;
  readonly actualRevision?: number;
  readonly message: string;
}> {}

export class StaleRouteError extends Data.TaggedError("StaleRouteError")<{
  readonly message: string;
}> {}

export class ProvisioningError extends Data.TaggedError("ProvisioningError")<{
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}> {}

export interface TenantAuthorizationRequest {
  readonly principal: Principal;
  readonly identity: InstanceIdentity;
  readonly operation: DatabaseOperation;
}

export interface TenantAuthorizerService {
  readonly authorize: (
    request: TenantAuthorizationRequest,
  ) => Effect.Effect<void, AuthorizationError>;
}

export class TenantAuthorizer extends Context.Service<TenantAuthorizer, TenantAuthorizerService>()(
  "triplex-host/TenantAuthorizer",
) {}

export interface TenantRegistryService {
  readonly get: (
    identity: InstanceIdentity,
  ) => Effect.Effect<TenantRecord | null, InstanceNotFoundError>;
  readonly compareAndSet: (
    record: TenantRecord,
    expectedRevision: number | null,
  ) => Effect.Effect<TenantRecord, RegistryConflictError>;
}

export class TenantRegistry extends Context.Service<TenantRegistry, TenantRegistryService>()(
  "triplex-host/TenantRegistry",
) {}

export interface TenantProvisionerService {
  readonly ensure: (
    desired: TenantRecord,
  ) => Effect.Effect<
    TenantRecord,
    InstanceNotFoundError | RegistryConflictError | ProvisioningError
  >;
  readonly inspect: (
    identity: InstanceIdentity,
  ) => Effect.Effect<TenantRecord, InstanceNotFoundError | ProvisioningError>;
  readonly suspend: (
    identity: InstanceIdentity,
    operationId: string,
  ) => Effect.Effect<
    TenantRecord,
    InstanceNotFoundError | RegistryConflictError | ProvisioningError
  >;
  readonly resume: (
    identity: InstanceIdentity,
    operationId: string,
  ) => Effect.Effect<
    TenantRecord,
    InstanceNotFoundError | RegistryConflictError | ProvisioningError
  >;
  readonly retire: (
    identity: InstanceIdentity,
    operationId: string,
  ) => Effect.Effect<
    TenantRecord,
    InstanceNotFoundError | RegistryConflictError | ProvisioningError
  >;
}

export class TenantProvisioner extends Context.Service<
  TenantProvisioner,
  TenantProvisionerService
>()("triplex-host/TenantProvisioner") {}
