import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ExportTarget = string | { default?: string; import?: string; types?: string };
type PackageJson = { name?: string; exports?: Record<string, ExportTarget> };

const workspaceRoot = path.dirname(fileURLToPath(import.meta.url));

const exportTarget = (target: ExportTarget): string | undefined =>
  typeof target === "string" ? target : (target.import ?? target.default ?? target.types);

const sourceFor = (packageDir: string, target: ExportTarget): string | undefined => {
  const built = exportTarget(target);
  if (!built?.startsWith("./dist/")) return undefined;
  const source = built
    .replace("./dist/", "./src/")
    .replace(/\.d\.ts$/, ".ts")
    .replace(/\.js$/, ".ts");
  const absolute = path.resolve(packageDir, source);
  return fs.existsSync(absolute) ? absolute : undefined;
};

export function workspaceAliases() {
  const aliases: Array<{ find: RegExp; replacement: string }> = [];
  const packagesDir = path.join(workspaceRoot, "packages");

  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDir = path.join(packagesDir, entry.name);
    const manifestPath = path.join(packageDir, "package.json");
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PackageJson;
    if (!manifest.name?.startsWith("@triplex-build/triplex")) continue;

    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      const replacement = sourceFor(packageDir, target);
      if (!replacement) continue;
      const specifier = subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
      aliases.push({
        find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
        replacement,
      });
    }
  }

  return aliases;
}
