import type { TenantDatabase, TenantRegistryObject } from "../src/worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    readonly TENANT_DATABASES: DurableObjectNamespace<TenantDatabase>;
    readonly TENANT_REGISTRY: DurableObjectNamespace<TenantRegistryObject>;
    readonly ADMIN_TOKEN: string;
    readonly INTERNAL_CAPABILITY: string;
    readonly TENANT_TOKENS: string;
    readonly HOST_ENVIRONMENT: string;
    readonly RUNTIME_RELEASE: string;
  }
}
