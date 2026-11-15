import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/server/main.ts", "src/seed/seed.ts"],
  format: "esm",
  target: "esnext",
  unbundle: true,
  fixedExtension: false,
  dts: false,
  outDir: "dist-server",
  clean: true,
});
