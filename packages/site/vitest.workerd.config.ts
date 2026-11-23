import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { evalStack } from "alchemy/Stack";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import { Effect } from "effect";
import { defineConfig } from "vitest/config";
import stack from "../../alchemy.run.ts";
import { workspaceAliases } from "../../vitest.workspace-aliases";

const root = fileURLToPath(new URL("../..", import.meta.url));

// The Worker under test is the one alchemy.run.ts deploys: its entry, compatibility settings
// and bindings come from evaluating the stack, so there is no separate Wrangler config.
const worker = await Effect.runPromise(
  evalStack(stack, (compiled) => Effect.sync(() => compiled.resources["Docs"]!.Props), {
    stage: "test",
  }).pipe(
    Effect.provideService(AlchemyContext, { dotAlchemy: ".alchemy", dev: true, adopt: false }),
    Effect.provide(PlatformServices),
  ) as Effect.Effect<any>,
);

const bindings = Object.entries(worker.env as Record<string, any>);

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: `${root}/${worker.main}`,
      miniflare: {
        compatibilityDate: worker.compatibility.date,
        compatibilityFlags: worker.compatibility.flags,
        durableObjects: Object.fromEntries(
          bindings
            .filter(([, binding]) => binding.kind === "Cloudflare.DurableObject")
            .map(([name, binding]) => [name, { className: binding.className, useSQLite: true }]),
        ),
        ratelimits: Object.fromEntries(
          bindings
            .filter(([, binding]) => binding.kind === "Cloudflare.RateLimit")
            .map(([name, binding]) => [
              name,
              { namespace_id: String(binding.namespaceId), simple: binding.simple },
            ]),
        ),
      },
    }),
  ],
  resolve: { alias: workspaceAliases() },
  test: {
    // Workerd cannot read Vitest 5's transformed modules from the host filesystem.
    fsModuleCache: false,
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
