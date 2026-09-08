import type { TriplexTestObject } from "./fixtures/WorkerdHarness.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    readonly TRIPLEX_TEST_OBJECTS: DurableObjectNamespace<TriplexTestObject>;
  }
}
