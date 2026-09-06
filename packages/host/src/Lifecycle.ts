import { Data, Schema } from "effect";
import { InstanceIdentity } from "./Identity.js";

export const InstanceLifecycleState = Schema.Literals([
  "provisioning",
  "ready",
  "suspended",
  "deleting",
  "deleted",
]);
export type InstanceLifecycleState = typeof InstanceLifecycleState.Type;

export const ProviderPlacement = Schema.Struct({
  provider: Schema.String,
  location: Schema.String,
  instanceKey: Schema.String,
});
export type ProviderPlacement = typeof ProviderPlacement.Type;

export const OperationFailure = Schema.Struct({
  operationId: Schema.String,
  message: Schema.String,
  recordedAt: Schema.Number,
  retryable: Schema.Boolean,
});
export type OperationFailure = typeof OperationFailure.Type;

export const TenantRecord = Schema.Struct({
  identity: InstanceIdentity,
  placement: ProviderPlacement,
  state: InstanceLifecycleState,
  revision: Schema.Number.pipe(Schema.check(Schema.isInt())),
  routingRevision: Schema.Number.pipe(Schema.check(Schema.isInt())),
  operationId: Schema.String,
  runtimeRelease: Schema.String,
  storageSchemaVersion: Schema.Number.pipe(Schema.check(Schema.isInt())),
  configSnapshot: Schema.optional(Schema.String),
  lastFailure: Schema.optional(OperationFailure),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type TenantRecord = typeof TenantRecord.Type;

export class InvalidLifecycleTransitionError extends Data.TaggedError(
  "InvalidLifecycleTransitionError",
)<{
  readonly from: InstanceLifecycleState;
  readonly to: InstanceLifecycleState;
  readonly message: string;
}> {}

const allowed: Readonly<Record<InstanceLifecycleState, readonly InstanceLifecycleState[]>> = {
  provisioning: ["ready", "deleting"],
  ready: ["suspended", "deleting"],
  suspended: ["ready", "deleting"],
  deleting: ["deleted"],
  deleted: [],
};

export const canTransition = (from: InstanceLifecycleState, to: InstanceLifecycleState): boolean =>
  allowed[from].includes(to);

export const transitionRecord = (
  record: TenantRecord,
  to: InstanceLifecycleState,
  operationId: string,
  now: number,
): TenantRecord => {
  if (!canTransition(record.state, to)) {
    throw new InvalidLifecycleTransitionError({
      from: record.state,
      to,
      message: `Cannot transition a tenant instance from ${record.state} to ${to}`,
    });
  }
  const routeChanged = to === "ready" || to === "suspended" || to === "deleting";
  return {
    ...record,
    state: to,
    revision: record.revision + 1,
    routingRevision: routeChanged ? record.routingRevision + 1 : record.routingRevision,
    operationId,
    updatedAt: now,
    lastFailure: undefined,
  };
};
