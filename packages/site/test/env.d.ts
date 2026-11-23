declare global {
  namespace Cloudflare {
    interface Env {
      readonly SESSIONS: DurableObjectNamespace<import("../src/worker.js").TriplexSession>;
    }
    interface GlobalProps {
      mainModule: typeof import("../src/worker.js");
    }
  }
}
export {};
