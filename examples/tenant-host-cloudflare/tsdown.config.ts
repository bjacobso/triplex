import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/worker.ts"],
  format: "esm",
  target: "esnext",
  dts: false,
  sourcemap: true,
  clean: true,
  outDir: "dist",
});
