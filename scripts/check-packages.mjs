import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "triplex-pack-"));
const tarDir = join(work, "tarballs");
const consumer = join(work, "consumer");
mkdirSync(tarDir);
mkdirSync(consumer);
const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe" });
const write = (file, body) => writeFileSync(join(consumer, file), body);
const install = () =>
  run(
    "npm",
    ["install", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"],
    consumer,
  );
const optionalDrivers = [
  "@effect/sql-sqlite-node",
  "@effect/sql-pg",
  "foundationdb",
  "@effect/platform-node",
  "@effect/platform-node-shared",
];
const children = [];
const start = (cli, args) => {
  const child = spawn(cli, args, { cwd: consumer, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  return child;
};
const stop = async (child) => {
  if (child.exitCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill();
  await exited;
};

try {
  run("node", ["--test", "scripts/check-single-package.test.mjs"]);
  run("pnpm", ["pack", "--pack-destination", tarDir]);
  const tarballs = readdirSync(tarDir).filter((file) => file.endsWith(".tgz"));
  assert.equal(tarballs.length, 1);
  const tarball = join(tarDir, tarballs[0]);
  const manifest = JSON.parse(run("tar", ["-xOzf", tarball, "package/package.json"]));
  const entries = run("tar", ["-tzf", tarball]).trim().split("\n");
  assert.equal(manifest.name, "@triplex-build/triplex");
  assert.ok(!manifest.private);
  assert.deepEqual(Object.keys(manifest.dependencies), ["ulidx"]);
  for (const [name, version] of Object.entries({
    ...manifest.dependencies,
    ...manifest.peerDependencies,
  })) {
    assert.ok(!name.startsWith("@triplex-") && !version.startsWith("workspace:"), name);
  }
  for (const section of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
  ]) {
    for (const range of Object.values(section ?? {}))
      assert.ok(!range.startsWith("workspace:"), range);
  }
  for (const name of optionalDrivers)
    assert.equal(manifest.peerDependenciesMeta[name].optional, true);
  for (const file of entries) {
    assert.ok(
      ["package/package.json", "package/README.md", "package/LICENSE"].includes(file) ||
        file.startsWith("package/dist/"),
      file,
    );
  }
  assert.ok(entries.includes("package/dist/dashboard/index.html"));
  for (const entry of Object.values(manifest.exports)) {
    for (const target of [entry.types, entry.import])
      assert.ok(entries.includes(`package/${target.slice(2)}`), target);
  }
  const dependencies = { "@triplex-build/triplex": `file:${tarball}`, effect: "4.1.1" };
  write("package.json", JSON.stringify({ private: true, type: "module", dependencies }));
  install();
  write(
    "isolation.mjs",
    `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const name of ${JSON.stringify(optionalDrivers)}) assert.throws(() => require.resolve(name));
for (const name of ${JSON.stringify(Object.keys(manifest.exports).filter((key) => !["./sqlite", "./postgres", "./foundationdb", "./testkit/postgres"].includes(key)))}) {
  await import('@triplex-build/triplex' + (name === '.' ? '' : name.slice(1)));
}
`,
  );
  run("node", ["isolation.mjs"], consumer);
  console.log("PASS: root and every driver-free subpath import with no drivers installed.");
  // Browser-safe core entrypoints must never reach Node or backend imports.
  const visited = new Set();
  const visit = (file) => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*\(|import\s*)["']([^"']+)["']/g)) {
      const spec = match[1];
      assert.ok(
        !spec.startsWith("node:") &&
          !spec.startsWith("@effect/platform-node") &&
          !spec.startsWith("@effect/sql-"),
        `${file}: ${spec}`,
      );
      if (spec.startsWith(".")) {
        const target = resolve(file, "..", spec);
        assert.ok(target.includes("/dist/core/"), target);
        visit(target);
      }
    }
  };
  for (const entry of Object.values(manifest.exports)) {
    if (entry.import.startsWith("./dist/core/"))
      visit(join(consumer, "node_modules/@triplex-build/triplex", entry.import));
  }
  console.log("PASS: browser-safe core module graph contains no Node or backend imports.");
  const cli = join(consumer, "node_modules/.bin/triplex");
  assert.ok(run(cli, ["--help"], consumer).includes("mcp"));
  assert.equal(run(cli, ["--version"], consumer).trim(), manifest.version);
  // Library consumers need only Effect and the selected backend driver.
  dependencies["@effect/sql-sqlite-node"] = "4.1.1";
  write("package.json", JSON.stringify({ private: true, type: "module", dependencies }));
  install();
  write("smoke.mjs", readFileSync(join(root, "scripts/fixtures/package-smoke.mjs"), "utf8"));
  run("node", ["smoke.mjs"], consumer);
  console.log("PASS: SQLite/Datalog/derivation behavior with only Effect and the SQLite driver.");
  // Node services are optional peers used only for executable database commands.
  dependencies["@effect/platform-node"] = "4.1.1";
  dependencies["@effect/platform-node-shared"] = "4.1.1";
  dependencies["@effect/sql-sqlite-node"] = "4.1.1";
  dependencies.typescript = "6.0.2";
  write("package.json", JSON.stringify({ private: true, type: "module", dependencies }));
  install();
  assert.ok(run(cli, ["--help"], consumer).includes("mcp"));
  assert.equal(run(cli, ["--version"], consumer).trim(), manifest.version);
  write(
    "consumer.ts",
    readFileSync(join(root, "scripts/fixtures/package-consumer.ts"), "utf8") +
      "\n" +
      Object.keys(manifest.exports)
        .map(
          (key, i) =>
            `import * as m${i} from '@triplex-build/triplex${key === "." ? "" : key.slice(1)}'; void m${i};`,
        )
        .join("\n"),
  );
  run(
    join(consumer, "node_modules/.bin/tsc"),
    [
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "nodenext",
      "--target",
      "esnext",
      "consumer.ts",
    ],
    consumer,
  );
  console.log("PASS: all subpath declarations compile in the clean consumer.");
  const described = JSON.parse(
    run(cli, ["--sqlite", join(consumer, "smoke.sqlite"), "describe"], consumer),
  );
  assert.equal(described.ok, true);
  const mcp = start(cli, ["mcp", "--sqlite", join(consumer, "mcp.sqlite")]);
  let stderr = "";
  mcp.stderr.on("data", (data) => {
    stderr += data;
  });
  const initialized = new Promise((done, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error(`MCP initialize timed out: ${output}\n${stderr}`)),
      20000,
    );
    mcp.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`MCP exited ${code}: ${stderr}`));
    });
    mcp.stdout.on("data", (data) => {
      output += data;
      const lines = output.split("\n");
      output = lines.pop();
      try {
        for (const line of lines) {
          const message = JSON.parse(line);
          if (message.id === 1) {
            clearTimeout(timeout);
            assert.ok(message.result?.serverInfo, JSON.stringify(message));
            done();
          }
        }
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  });
  mcp.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "pack-check", version: "1" },
      },
    }) + "\n",
  );
  await initialized;
  await stop(mcp);
  console.log("PASS: triplex --help, --version, SQLite describe, and mcp initialize.");
  const port = await new Promise((done) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => done(port));
    });
  });
  const dashboard = start(cli, [
    "dashboard",
    "--sqlite",
    join(consumer, "dashboard.sqlite"),
    "--port",
    String(port),
  ]);
  let dashboardError = "";
  dashboard.stderr.on("data", (data) => {
    dashboardError += data;
  });
  let response;
  for (let i = 0; i < 100; i++) {
    if (dashboard.exitCode !== null) throw new Error(`Dashboard exited: ${dashboardError}`);
    try {
      response = await fetch(`http://127.0.0.1:${port}/`);
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  assert.equal(response?.status, 200, dashboardError);
  const html = await response.text();
  const assets = [...html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)].map(
    (match) => match[1],
  );
  assert.ok(assets.length > 0);
  for (const asset of assets)
    assert.equal((await fetch(new URL(asset, `http://127.0.0.1:${port}`))).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
  await stop(dashboard);
  console.log("PASS: triplex dashboard serves its HTML, JavaScript, CSS and health endpoint.");
  console.log("Verified one package tarball and a clean consumer install.");
  rmSync(work, { recursive: true, force: true });
} catch (error) {
  console.error(`Package verification artifacts retained at ${work}`);
  if (error.stdout) console.error(error.stdout.toString());
  if (error.stderr) console.error(error.stderr.toString());
  throw error;
} finally {
  for (const child of children) await stop(child);
}
