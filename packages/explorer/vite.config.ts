import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm dev` proxies the API to a host started with `pnpm serve` on port 4176.
export default defineConfig({
  plugins: [react()],
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
