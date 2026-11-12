import { defineConfig } from "tsdown";
export default defineConfig({
  entry: ["src/server.ts", "src/api.ts", "src/data.ts", "src/model.ts", "src/server-security.ts"],
  format: "esm",
  target: "esnext",
  unbundle: true,
  fixedExtension: false,
  dts: false,
  outDir: "dist-server",
  clean: true,
});
