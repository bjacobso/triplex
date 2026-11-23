import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as State from "alchemy/State";
import { workspaceAliases } from "./vitest.workspace-aliases.ts";

export default Alchemy.Stack(
  "triplex",
  {
    providers: Cloudflare.providers(),
    // The `local` stage (`pnpm site:dev`) keeps state on disk, so `alchemy dev` needs no
    // Cloudflare account. Every other stage keeps state in Cloudflare.
    state: Layer.unwrap(
      Effect.map(Alchemy.Stage, (stage) =>
        stage === "local" ? State.localState() : Cloudflare.state(),
      ),
    ),
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
      // Bundle workspace packages from source: CI does not build their dist before deploying.
      build: {
        input: {
          resolve: {
            alias: Object.fromEntries(
              workspaceAliases().map(({ find, replacement }) => [
                `${find.source.slice(1, -1).replaceAll("\\/", "/")}$`,
                replacement,
              ]),
            ),
          },
        },
      },
      env: {
        SESSIONS: Cloudflare.Workers.DurableObject("Sessions", { className: "TriplexSession" }),
        MCP_CALLS: Cloudflare.Workers.RateLimit("McpCalls", {
          namespaceId: 2001,
          simple: { limit: 120, period: 60 },
        }),
      },
      workersDev: true,
      // `alchemy dev` runs this Worker in local workerd over the built site, so /mcp works
      // locally too. Use `pnpm docs:dev` for VitePress hot reload while writing docs.
      dev: { port: 8787 },
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
