import { Effect } from "effect";
import type { InstanceIdentity } from "./Identity.js";
import {
  InstanceNotFoundError,
  InstanceUnavailableError,
  TenantAuthorizer,
  TenantRegistry,
  type DatabaseOperation,
  type Principal,
} from "./Services.js";

/** Resolve a ready placement and authorize it before a gateway obtains a handle. */
export const resolveAuthorizedPlacement = (
  principal: Principal,
  identity: InstanceIdentity,
  operation: DatabaseOperation,
) =>
  Effect.gen(function* () {
    const registry = yield* TenantRegistry;
    const record = yield* registry.get(identity);
    if (record === null) {
      return yield* Effect.fail(
        new InstanceNotFoundError({ message: "Tenant instance was not found" }),
      );
    }
    if (record.state !== "ready") {
      return yield* Effect.fail(
        new InstanceUnavailableError({
          state: record.state,
          message: `Tenant instance is ${record.state}`,
        }),
      );
    }
    const authorizer = yield* TenantAuthorizer;
    yield* authorizer.authorize({ principal, identity, operation });
    return record;
  });
