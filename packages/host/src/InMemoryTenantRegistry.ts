import { Effect, Layer } from "effect";
import { canonicalInstanceIdentity } from "./Identity.js";
import { RegistryConflictError, TenantRegistry, type TenantRegistryService } from "./Services.js";

/** Test/reference registry. Production hosts must provide durable storage. */
export const InMemoryTenantRegistryLive = Layer.sync(TenantRegistry, () => {
  const records = new Map<string, Parameters<TenantRegistryService["compareAndSet"]>[0]>();
  return TenantRegistry.of({
    get: (identity) => Effect.succeed(records.get(canonicalInstanceIdentity(identity)) ?? null),
    compareAndSet: (record, expectedRevision) =>
      Effect.suspend(() => {
        const key = canonicalInstanceIdentity(record.identity);
        const current = records.get(key);
        const actualRevision = current?.revision;
        const matches =
          expectedRevision === null ? current === undefined : actualRevision === expectedRevision;
        if (!matches) {
          return Effect.fail(
            new RegistryConflictError({
              expectedRevision: expectedRevision ?? -1,
              ...(actualRevision === undefined ? {} : { actualRevision }),
              message: `Tenant registry revision conflict for ${key}`,
            }),
          );
        }
        records.set(key, record);
        return Effect.succeed(record);
      }),
  });
});
