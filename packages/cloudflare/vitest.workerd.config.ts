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
    include: ["test/**/*.workerd.test.ts"],
  },
});
