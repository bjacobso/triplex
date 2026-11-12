import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("only the unified Triplex package can publish", () => {
  const manifests = readdirSync(new URL("../packages/", import.meta.url)).map((name) =>
    JSON.parse(readFileSync(new URL(`../packages/${name}/package.json`, import.meta.url))),
  );
  assert.deepEqual(
    manifests.filter((p) => !p.private).map((p) => p.name),
    ["@triplex-build/triplex"],
  );
  const manifest = manifests.find((p) => !p.private);
  for (const path of [
    "sql",
    "sqlite",
    "postgres",
    "cloudflare",
    "foundationdb",
    "host",
    "http",
    "testkit",
    "mcp",
  ]) {
    assert.ok(manifest.exports[`./${path}`], `missing /${path}`);
  }
  for (const driver of [
    "@effect/sql-sqlite-node",
    "@effect/sql-pg",
    "foundationdb",
    "@effect/platform-node",
    "@effect/platform-node-shared",
  ]) {
    assert.equal(manifest.peerDependenciesMeta[driver].optional, true);
  }
});
