import { describe } from "vitest";
import { KvTriples } from "@triplex-build/triplex";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";
import { databaseBehavior } from "./database-behavior.js";

for (const [name, backend] of [
  ["KV", KvTriples.layer],
  ["SQLite", SqliteTriples.layerMemory],
] as const) {
  describe(`Database ${name}`, () => databaseBehavior(backend));
}
