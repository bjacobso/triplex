import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "triplex",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const docs = yield* Cloudflare.Website.StaticSite("Docs", {
      name: stage === "prod" ? "triplex-docs" : `triplex-docs-${stage}`,
      ...(stage === "prod" ? { domain: "triplex.build" } : {}),
      // The docs plus the static playground. Alchemy passes the command without a shell,
      // so chaining belongs in the package script, not here.
      command: "pnpm site:build",
      outdir: "dist",
      // The Worker serves the docs, and MCP clients that POST to /mcp get the hosted demo:
      // one Durable Object per MCP session holds that session's own Triplex database.
      main: "packages/site/src/worker.ts",
      compatibility: { date: "2026-09-06", flags: ["nodejs_compat"] },
      env: {
        SESSIONS: Cloudflare.Workers.DurableObject("Sessions", { className: "TriplexSession" }),
        MCP_CALLS: Cloudflare.Workers.RateLimit("McpCalls", {
          namespaceId: 2001,
          simple: { limit: 120, period: 60 },
        }),
      },
      workersDev: true,
      dev: { command: "pnpm docs:dev" },
      assets: { notFoundHandling: "404-page", runWorkerFirst: ["/mcp", "/mcp/"] },
      memo: {
        include: [
          "docs/**",
          "packages/site/src/**",
          "packages/mcp/src/**",
          "packages/cli/src/**",
          "packages/core/src/**",
          "packages/explorer/src/**",
          "packages/explorer/playground/**",
          "packages/explorer/vite.playground.config.ts",
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
        ],
        lockfile: true,
      },
    });

    return { url: docs.url };
  }),
);
