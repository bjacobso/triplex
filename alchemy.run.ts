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
      // The playground is static and runs Triplex in the page, so the same Worker serves it.
      command: "pnpm docs:build && pnpm playground:build",
      outdir: "dist",
      workersDev: true,
      dev: { command: "pnpm docs:dev" },
      assets: { notFoundHandling: "404-page" },
      memo: {
        include: [
          "docs/**",
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
