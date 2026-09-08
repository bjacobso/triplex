import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type { TenantDatabase, TenantRegistryObject } from "./src/worker.js";

export default Alchemy.Stack(
  "triplex-tenant-host",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const adminToken = yield* Config.redacted("TRIPLEX_HOST_ADMIN_TOKEN");
    const internalCapability = yield* Config.redacted("TRIPLEX_HOST_INTERNAL_CAPABILITY");
    const tenantTokens = yield* Config.redacted("TRIPLEX_HOST_TENANT_TOKENS");

    const worker = yield* Cloudflare.Worker("TenantHost", {
      name: "triplex-tenant-host",
      main: "./src/worker.ts",
      compatibility: { date: "2026-09-04" },
      workersDev: true,
      env: {
        TENANT_DATABASES: Cloudflare.DurableObject<TenantDatabase>("TenantDatabases", {
          className: "TenantDatabase",
        }),
        TENANT_REGISTRY: Cloudflare.DurableObject<TenantRegistryObject>("TenantRegistry", {
          className: "TenantRegistryObject",
        }),
        ADMIN_TOKEN: adminToken,
        INTERNAL_CAPABILITY: internalCapability,
        TENANT_TOKENS: tenantTokens,
        HOST_ENVIRONMENT: "dev",
        RUNTIME_RELEASE: "triplex-tenant-host-v1",
      },
    }).pipe(Alchemy.RemovalPolicy.retain());

    return {
      url: worker.url,
      release: "triplex-tenant-host-v1",
      provider: "cloudflare-durable-objects",
    };
  }),
);
