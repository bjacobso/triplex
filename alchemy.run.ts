import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
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
      name: "triplex-docs",
      ...(stage === "prod" ? { domain: "triplex.build" } : {}),
      command: "pnpm docs:build",
      outdir: "dist",
      workersDev: true,
      dev: { command: "pnpm docs:dev" },
      assets: { notFoundHandling: "404-page" },
      memo: {
        include: ["docs/**", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"],
        lockfile: true,
      },
    });

    return { url: docs.url };
  }),
);
