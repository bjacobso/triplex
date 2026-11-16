import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds only the playground into the documentation output, so the Alchemy Docs Worker
// serves it at /playground/ beside the docs. Runs after `pnpm docs:build`, which empties dist.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../../dist", import.meta.url)),
    emptyOutDir: false,
    assetsDir: "playground/assets",
    rollupOptions: {
      input: { playground: fileURLToPath(new URL("playground/index.html", import.meta.url)) },
    },
  },
});
