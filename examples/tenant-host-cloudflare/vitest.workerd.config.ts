import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.workspace-aliases";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
    }),
  ],
  resolve: {
    alias: workspaceAliases(),
  },
  test: {
    // Workerd cannot read Vitest 5's transformed modules from the host filesystem.
    fsModuleCache: false,
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
