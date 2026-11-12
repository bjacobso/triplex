import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "packages/triplex/dist");
const modules = [
  "core",
  "sql",
  "sqlite",
  "postgres",
  "cloudflare",
  "foundationdb",
  "host",
  "http",
  "testkit",
  "cli",
  "mcp",
];
const targets = new Map();
for (const name of modules) {
  const manifest = JSON.parse(readFileSync(join(root, `packages/${name}/package.json`), "utf8"));
  for (const [subpath, entry] of Object.entries(manifest.exports)) {
    targets.set(
      manifest.name + (subpath === "." ? "" : subpath.slice(1)),
      `${name}/${entry.import.replace("./dist/", "")}`,
    );
  }
}
rmSync(output, { recursive: true, force: true });
for (const name of modules)
  cpSync(join(root, `packages/${name}/dist`), join(output, name), { recursive: true });
// The server uses only its API contracts and Node services, never the UI runtime.
for (const name of ["server", "api", "data", "model", "server-security"]) {
  cpSync(
    join(root, `packages/dashboard/dist-server/${name}.js`),
    join(output, `dashboard-server/${name}.js`),
  );
}
cpSync(join(root, "packages/dashboard/dist"), join(output, "dashboard"), { recursive: true });
const rewrite = (directory) => {
  for (const file of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, file.name);
    if (file.isDirectory()) {
      rewrite(path);
      continue;
    }
    if (!/\.(?:js|ts)$/.test(file.name)) continue;
    const text = readFileSync(path, "utf8").replace(
      /(["'])(@triplex-(?:build|internal)\/[^"']+)\1/g,
      (match, quote, specifier) => {
        const target = targets.get(specifier);
        if (!target && /^@triplex-build\/triplex(?:\/|$)/.test(specifier)) return match;
        if (!target) throw new Error(`Unknown workspace import ${specifier} in ${path}`);
        const rel = relative(dirname(path), join(output, target));
        return `${quote}${rel.startsWith(".") ? rel : `./${rel}`}${quote}`;
      },
    );
    writeFileSync(path, text);
  }
};
rewrite(output);
const manifest = JSON.parse(readFileSync(join(root, "packages/triplex/package.json"), "utf8"));
const help = execFileSync(process.execPath, [join(root, "packages/cli/dist/cli.js"), "--help"], {
  encoding: "utf8",
  env: { ...process.env, NO_COLOR: "1" },
});
writeFileSync(
  join(output, "bin.js"),
  `#!/usr/bin/env node
const command = process.argv[2];
if (command === "--help" || command === "-h") {
  console.log("Additional commands: mcp (stdio MCP server), dashboard (local explorer)");
  process.stdout.write(${JSON.stringify(help)});
} else if (command === "mcp" || command === "dashboard") {
  process.argv.splice(2, 1);
  await import(command === "mcp" ? "./mcp/bin.js" : "./dashboard-server/server.js");
} else if (command === "--version") {
  console.log(${JSON.stringify(manifest.version)});
} else {
  await import("./cli/cli.js");
}
`,
);
chmodSync(join(output, "bin.js"), 0o755);
for (const entry of Object.values(manifest.exports)) {
  for (const target of [entry.import, entry.types]) {
    if (!existsSync(resolve(root, "packages/triplex", target)))
      throw new Error(`Missing export ${target}`);
  }
}
console.log("Assembled one Triplex package with isolated subpaths and dashboard assets.");

// Stage only the consumer manifest. Build-only workspace dependencies must never
// become registry dependencies or leak into the packed manifest.
const publish = join(root, "packages/triplex/publish");
rmSync(publish, { recursive: true, force: true });
cpSync(output, join(publish, "dist"), { recursive: true });
for (const file of ["README.md", "LICENSE"])
  cpSync(join(root, "packages/triplex", file), join(publish, file));
const {
  devDependencies: _buildInputs,
  scripts: _scripts,
  publishConfig: _publishConfig,
  ...published
} = manifest;
writeFileSync(
  join(publish, "package.json"),
  JSON.stringify({ ...published, publishConfig: { access: "public" } }, null, 2) + "\n",
);
