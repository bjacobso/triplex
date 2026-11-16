import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm dev` proxies the API to a host started with `pnpm serve` on port 4176.
// The playground (/playground/) needs no host: its database runs in the page.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        explorer: fileURLToPath(new URL("index.html", import.meta.url)),
        playground: fileURLToPath(new URL("playground/index.html", import.meta.url)),
      },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4176",
        // The host only answers its own loopback origin.
        headers: { origin: "http://localhost:4176" },
      },
    },
  },
});
