import { defineConfig } from "tsdown";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../triplex/package.json", import.meta.url), "utf8"),
) as { readonly version: string };

export default defineConfig({
  entry: ["src/**/*.ts"],
  format: "esm",
  target: "esnext",
  unbundle: true,
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  define: {
    __TRIPLEX_CLI_VERSION__: JSON.stringify(packageJson.version),
  },
});
