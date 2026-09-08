import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.workspace-aliases";

export default defineConfig({
  resolve: { alias: workspaceAliases() },
  test: {
    include: ["test/**/*.test.ts"],
    // Missing or changed contracts must be accepted explicitly with --update.
    update: "none",
  },
});
