import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageNames = [
  "@bjacobso/triplex",
  "@bjacobso/triplex-sql",
  "@bjacobso/triplex-sqlite",
  "@bjacobso/triplex-postgres",
  "@bjacobso/triplex-cloudflare",
  "@bjacobso/triplex-foundationdb",
  "@bjacobso/triplex-testkit",
  "@bjacobso/triplex-cli",
  "@bjacobso/triplex-http",
];
const publishPackageNames = new Set([
  "@bjacobso/triplex",
  "@bjacobso/triplex-sql",
  "@bjacobso/triplex-sqlite",
  "@bjacobso/triplex-postgres",
  "@bjacobso/triplex-testkit",
  "@bjacobso/triplex-cli",
  "@bjacobso/triplex-http",
]);
const heldPackageNames = new Set([
  "@bjacobso/triplex-cloudflare",
  "@bjacobso/triplex-foundationdb",
]);

const workDir = mkdtempSync(join(tmpdir(), "triplex-pack-"));
const tarDir = join(workDir, "tarballs");
const consumerDir = join(workDir, "consumer");
const packedManifests = [];
mkdirSync(tarDir);
mkdirSync(consumerDir);

const run = (command, args, cwd = root) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });

try {
  for (const packageName of packageNames) {
    run("pnpm", ["--filter", packageName, "pack", "--pack-destination", tarDir]);
  }

  const tarballs = readdirSync(tarDir)
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => join(tarDir, file));

  if (tarballs.length !== packageNames.length) {
    throw new Error(`Expected ${packageNames.length} tarballs, found ${tarballs.length}`);
  }

  for (const tarball of tarballs) {
    const entries = run("tar", ["-tzf", tarball]).trim().split("\n").filter(Boolean);

    for (const required of [
      "package/package.json",
      "package/README.md",
      "package/LICENSE",
      "package/dist/index.js",
      "package/dist/index.d.ts",
    ]) {
      if (!entries.includes(required)) {
        throw new Error(`${tarball} is missing ${required}`);
      }
    }

    const unexpected = entries.filter(
      (entry) =>
        entry !== "package/package.json" &&
        entry !== "package/README.md" &&
        entry !== "package/LICENSE" &&
        !entry.startsWith("package/dist/"),
    );
    if (unexpected.length > 0) {
      throw new Error(`${tarball} contains unexpected files:\n${unexpected.join("\n")}`);
    }

    const manifest = JSON.parse(run("tar", ["-xOzf", tarball, "package/package.json"]));
    packedManifests.push(manifest);
    if (publishPackageNames.has(manifest.name)) {
      if (manifest.private === true) {
        throw new Error(`${manifest.name} is part of the release set but is private`);
      }
      if (manifest.publishConfig?.access !== "public") {
        throw new Error(`${manifest.name} must publish with public access`);
      }
    }
    if (heldPackageNames.has(manifest.name) && manifest.private !== true) {
      throw new Error(`${manifest.name} must remain private until its backend is promoted`);
    }
    if (publishPackageNames.has(manifest.name)) {
      for (const dependencyName of Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      })) {
        if (heldPackageNames.has(dependencyName)) {
          throw new Error(`${manifest.name} must not depend on held package ${dependencyName}`);
        }
      }
    }
    if (manifest.dependencies?.effect !== undefined) {
      throw new Error(`${manifest.name} must not install a private Effect runtime`);
    }
    if (manifest.peerDependencies?.effect === undefined) {
      throw new Error(`${manifest.name} must declare Effect as a peer dependency`);
    }
  }

  const dependencies = Object.fromEntries(
    packageNames.map((name) => {
      const manifest = packedManifests.find((candidate) => candidate.name === name);
      if (!manifest) throw new Error(`Could not locate packed manifest for ${name}`);
      const prefix = `${name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`;
      const tarball = tarballs.find((file) => file.endsWith(prefix));
      if (!tarball) throw new Error(`Could not locate tarball for ${name}`);
      return [name, `file:${tarball}`];
    }),
  );
  const coreManifest = packedManifests.find((manifest) => manifest.name === "@bjacobso/triplex");
  if (!coreManifest) throw new Error("Could not locate the packed core manifest");
  const effectVersion = coreManifest.peerDependencies.effect;
  const effectPeerVersions = new Set(
    packedManifests.map((manifest) => manifest.peerDependencies.effect),
  );
  if (effectPeerVersions.size !== 1) {
    throw new Error(`Effect peer versions are not aligned: ${[...effectPeerVersions].join(", ")}`);
  }

  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify(
      {
        name: "triplex-package-consumer",
        private: true,
        type: "module",
        dependencies: {
          ...dependencies,
          effect: effectVersion,
          typescript: "6.0.2",
        },
        overrides: {
          // @effect/sql-sqlite-node 0.49 still declares v11. The workspace
          // applies the same override because v12 provides Node 24 support.
          "better-sqlite3": "12.10.0",
        },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(consumerDir, "consumer.ts"),
    `import { DatabaseId, DatalogValidationError, EntityId, TransactionId, TripleId, type TripleInput, type TriplesService } from "@bjacobso/triplex";
import { validateDatalogQuery, type DatalogQuery } from "@bjacobso/triplex/datalog";
import { Attribute, ConfigRuntime, ConfigStore, EntityType, EntityValidation, Evaluate, GraphConstraint, TypeExpr } from "@bjacobso/triplex/config";
import * as Derivation from "@bjacobso/triplex/derivation";
import * as Cloudflare from "@bjacobso/triplex-cloudflare";
import * as FoundationDb from "@bjacobso/triplex-foundationdb";
import * as Postgres from "@bjacobso/triplex-postgres";
import { PgTriples } from "@bjacobso/triplex-postgres";
import * as Sql from "@bjacobso/triplex-sql";
import { makeSqliteLayer } from "@bjacobso/triplex-sqlite";
import * as Testkit from "@bjacobso/triplex-testkit";
import { EntityHttp, HttpAuthorizationAllowAll } from "@bjacobso/triplex-http";

const triple: TripleInput = {
  entityId: EntityId.make("person:alice"),
  attribute: ":person/name",
  value: { type: "string", value: "Alice" },
};
const transactionId = TransactionId.make("_tx/00000000000000000000000000");
const tripleId = TripleId.make("00000000000000000000000000");
const transactionEntity: EntityId = transactionId;
declare const triplesService: TriplesService;
const timeline = triplesService.transactionsForEntity(triple.entityId, { limit: 20 });
const ambientPostgres = PgTriples.layerFromSqlClient({ scope: "host/database" });
const scopedPostgres = PgTriples.layerForDatabase(
  { database: "application" },
  DatabaseId.make("tenant-a"),
);
const query: DatalogQuery = {
  find: ["?name"],
  where: [["?person", ":person/name", "?name"]],
};
const EmployerName = Attribute.text(":employer/name");
const Employer = EntityType.make("Employer", {
  attributes: {
    name: Attribute.use(EmployerName, { required: true }),
  },
});
const nameAssertion = Employer.attributes.name.assertion("Acme");
void triple;
void transactionId;
void tripleId;
void transactionEntity;
void timeline;
void ambientPostgres;
void scopedPostgres;
void query;
void validateDatalogQuery;
void DatalogValidationError;
void nameAssertion;
void ConfigStore;
void ConfigRuntime;
void EntityValidation;
void Evaluate;
void GraphConstraint;
void TypeExpr;
void Derivation;
void Derivation.Materialization;
void Derivation.Overlay;
void makeSqliteLayer;
void Cloudflare;
void FoundationDb;
void Postgres;
void Sql;
void Testkit;
void EntityHttp;
void HttpAuthorizationAllowAll;
`,
  );

  writeFileSync(
    join(consumerDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["consumer.ts"],
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(consumerDir, "smoke.mjs"),
    `import { Effect } from "effect";
import { EntityId, Triples, string } from "@bjacobso/triplex";
import * as Derivation from "@bjacobso/triplex/derivation";
import { SqliteTriples } from "@bjacobso/triplex-sqlite";

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const triples = yield* Triples;
    const alice = EntityId.make("person:alice");
    const bob = EntityId.make("person:bob");
    yield* triples.assert({
      entityId: alice,
      attribute: ":person/name",
      value: string("Alice"),
      validFrom: 0,
      validTo: 5,
    });
    const query = {
      find: ["?name"],
      where: [["?person", ":person/name", "?name"]],
    };
    const definition = yield* Derivation.make({
      name: "person.names",
      query,
      identity: ["?name"],
      configSnapshot: "config:consumer-smoke",
    });
    yield* Derivation.Materialization.materialize(triples, definition, {
      basis: { validAt: 1 },
    });
    const preview = yield* Derivation.Overlay.evaluateOverlay(triples, definition, {
      basis: { validAt: 1 },
      overlay: {
        assertions: [{
          entityId: bob,
          attribute: ":person/name",
          value: string("Bob"),
        }],
      },
    });
    return {
      query: yield* triples.query(query, { basis: { validAt: 1 } }),
      preview,
      materialization: yield* Derivation.Materialization.current(triples, definition, {
        basis: { validAt: 1 },
      }),
    };
  }).pipe(Effect.provide(SqliteTriples.layerMemory)),
);

if (
  result.query.results.length !== 1 ||
  result.query.results[0]?.["?name"] !== "Alice" ||
  result.preview.candidates.length !== 2 ||
  result.preview.nextTemporalBoundary !== 5 ||
  !result.preview.candidates.some((candidate) =>
    candidate.sources.some((source) => source.hypothetical === true)
  ) ||
  result.materialization.status !== "current" ||
  result.materialization.nextTemporalBoundary !== 5 ||
  result.materialization.candidates.length !== 1
) {
  throw new Error("Unexpected packaged SQLite/Datalog result: " + JSON.stringify(result));
}
`,
  );

  // FoundationDB and SQLite both ship native addons. Install every package with
  // lifecycle scripts disabled so the type-level consumer check is portable,
  // then build only the SQLite addon exercised by the runtime smoke test.
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumerDir);
  run("npm", ["rebuild", "better-sqlite3"], consumerDir);
  run("npx", ["tsc", "--project", "tsconfig.json"], consumerDir);
  run("node", ["smoke.mjs"], consumerDir);

  const cliManifest = packedManifests.find((manifest) => manifest.name === "@bjacobso/triplex-cli");
  if (!cliManifest) throw new Error("Could not locate the packed CLI manifest");
  if (cliManifest.bin?.triplex !== "./dist/cli.js") {
    throw new Error("The packed CLI must expose dist/cli.js as the triplex executable");
  }
  const cli = join(consumerDir, "node_modules", ".bin", "triplex");
  run(cli, ["--help"], consumerDir);
  const version = run(cli, ["--version"], consumerDir);
  if (!version.includes(cliManifest.version)) {
    throw new Error(
      `Packed CLI version mismatch: expected ${cliManifest.version}, received ${version.trim()}`,
    );
  }
  const described = JSON.parse(
    run(cli, ["--sqlite", join(consumerDir, "agent.sqlite"), "describe"], consumerDir),
  );
  if (described.ok !== true || described.command !== "describe") {
    throw new Error(`Unexpected packed CLI description: ${JSON.stringify(described)}`);
  }

  process.stdout.write(
    `Verified ${tarballs.length} package tarballs and a clean consumer install.\n`,
  );
  rmSync(workDir, { recursive: true, force: true });
} catch (error) {
  process.stderr.write(`Package verification artifacts retained at ${workDir}\n`);
  throw error;
}
