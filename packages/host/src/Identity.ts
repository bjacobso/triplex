import { Schema } from "effect";
import { Sha256 } from "@bjacobso/triplex/content";

const OpaqueId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(128)),
  Schema.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)),
);

export const EnvironmentId = OpaqueId.pipe(Schema.brand("TriplexHostEnvironmentId"));
export type EnvironmentId = typeof EnvironmentId.Type;

export const TenantId = OpaqueId.pipe(Schema.brand("TriplexHostTenantId"));
export type TenantId = typeof TenantId.Type;

export const HostedDatabaseId = OpaqueId.pipe(Schema.brand("TriplexHostDatabaseId"));
export type HostedDatabaseId = typeof HostedDatabaseId.Type;

export const InstanceGeneration = OpaqueId.pipe(Schema.brand("TriplexHostInstanceGeneration"));
export type InstanceGeneration = typeof InstanceGeneration.Type;

export const InstanceIdentity = Schema.Struct({
  environment: EnvironmentId,
  tenantId: TenantId,
  databaseId: HostedDatabaseId,
  generation: InstanceGeneration,
});
export type InstanceIdentity = typeof InstanceIdentity.Type;

const encodePart = (value: string): string => `${new TextEncoder().encode(value).length}:${value}`;

/** Unambiguous stable identity used for scopes, logs, and registry keys. */
export const canonicalInstanceIdentity = (identity: InstanceIdentity): string =>
  `triplex-instance-v1:${[
    identity.environment,
    identity.tenantId,
    identity.databaseId,
    identity.generation,
  ]
    .map(encodePart)
    .join("")}`;

/** Provider-safe name derived from the complete immutable identity. */
export const providerInstanceKey = (identity: InstanceIdentity): string =>
  `triplex-${Sha256.hex(canonicalInstanceIdentity(identity))}`;

export const sameInstanceIdentity = (left: InstanceIdentity, right: InstanceIdentity): boolean =>
  canonicalInstanceIdentity(left) === canonicalInstanceIdentity(right);
