#!/usr/bin/env tsx
/**
 * Benchmark report generator.
 *
 * Runs the stress test against SQLite, PostgreSQL (via Docker), in-memory KV,
 * and FoundationDB (via Docker), collects structured JSON results, and
 * generates a markdown performance report at docs/performance.md.
 *
 * Uses the repo-level docker-compose.test.yml for PostgreSQL (same as
 * integration tests) with dynamic port discovery to avoid port conflicts.
 * FoundationDB runs in a dedicated benchmark container.
 *
 * Usage:
 *   pnpm --filter triplex-stress benchmark
 *
 * Requirements:
 *   - Docker (for PostgreSQL and FoundationDB containers)
 *   - FoundationDB client library (`libfdb_c`) on host for FDB benchmark
 *
 * Options (env vars):
 *   STRESS_EMPLOYEE_COUNT  - Number of employees (default: 1000000 when run via this script)
 *   STRESS_UPDATE_ROUNDS   - Number of update rounds per attribute (default: 10)
 *   BENCHMARK_SKIP_PG      - Set to "true" to skip PostgreSQL benchmark
 *   BENCHMARK_SKIP_SQLITE  - Set to "true" to skip SQLite benchmark
 *   BENCHMARK_SKIP_KV      - Set to "true" to skip in-memory KV benchmark
 *   BENCHMARK_SKIP_FDB     - Set to "true" to skip FoundationDB benchmark
 *   FDB_STORAGE_MODE=single|memory|single ssd|single memory - FoundationDB storage mode (default: single)
 *   FDB_IMAGE=foundationdb/foundationdb:7.3.43     - Docker image tag for FoundationDB benchmark
 *   FDB_PLATFORM=linux/amd64|linux/arm64           - Docker platform override (default: linux/amd64)
 */

import { execSync, type ExecSyncOptions } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GenericContainer, Wait } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";
import type { BenchmarkResults } from "../src/benchmark-results.js";

// ─── Paths ─────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(PKG_DIR, "../..");
const FDB_PKG_DIR = resolve(REPO_ROOT, "packages/foundationdb");
const FDB_CONTAINER_NAME = "triplex-build-benchmark-fdb";
const FDB_IMAGE = process.env["FDB_IMAGE"] ?? "foundationdb/foundationdb:7.3.75";
const FDB_HOST_PORT = 4500;
const FDB_PLATFORM = process.env["FDB_PLATFORM"] ?? "linux/amd64";
const FDB_CLUSTER_FILE_PATH = resolve(PKG_DIR, ".benchmark-fdb.cluster");
const DOCS_OUTPUT = resolve(REPO_ROOT, "docs/performance.md");

// ─── Benchmark defaults (when run via this script) ─────────────────────────

const DEFAULT_EMPLOYEE_COUNT = "1000000";
const DEFAULT_UPDATE_ROUNDS = "10";

// ─── Helpers ───────────────────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function log(msg: string) {
  process.stderr.write(`${msg}\n`);
}

function heading(msg: string) {
  log(`\n${BOLD}${GREEN}=== ${msg} ===${RESET}\n`);
}

function warn(msg: string) {
  log(`${YELLOW}WARNING: ${msg}${RESET}`);
}

class LoggedError extends Error {}

function fail(msg: string): never {
  log(`${RED}ERROR: ${msg}${RESET}`);
  throw new LoggedError(msg);
}

function run(cmd: string, opts?: ExecSyncOptions) {
  log(`${DIM}$ ${cmd}${RESET}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

/**
 * Run a command, returning true on success and false on failure.
 * Used for benchmark runs where assertion failures are non-fatal —
 * the JSON results are still written even if some query thresholds are exceeded.
 */
function runTolerant(cmd: string, opts?: ExecSyncOptions): boolean {
  log(`${DIM}$ ${cmd}${RESET}`);
  try {
    execSync(cmd, { stdio: "inherit", ...opts });
    return true;
  } catch {
    warn("Command exited with non-zero status (some assertions may have failed).");
    warn("Benchmark results may still have been collected — continuing.");
    return false;
  }
}

function runCapture(cmd: string, opts?: ExecSyncOptions): string {
  return execSync(cmd, { encoding: "utf-8", ...opts }).trim();
}

function dockerAvailable(): boolean {
  try {
    runCapture("docker info", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function fdbClientAvailable(): boolean {
  try {
    runCapture(
      `node -e "import('foundationdb').then((fdb)=>{fdb.setAPIVersion(720);console.log('ok')}).catch(()=>process.exit(1))"`,
      { cwd: FDB_PKG_DIR, stdio: "pipe" },
    );
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function startFoundationDb(): string {
  heading("Starting FoundationDB container");

  // Cleanup stale container/cluster file from previous runs.
  try {
    runCapture(`docker rm -f ${FDB_CONTAINER_NAME}`, { cwd: REPO_ROOT, stdio: "pipe" });
  } catch {
    // ignore
  }
  if (existsSync(FDB_CLUSTER_FILE_PATH)) {
    rmSync(FDB_CLUSTER_FILE_PATH);
  }

  run(
    `docker run -d --name ${FDB_CONTAINER_NAME} --platform ${FDB_PLATFORM} -p ${FDB_HOST_PORT}:4500 ${FDB_IMAGE}`,
    { cwd: REPO_ROOT },
  );

  // Wait for server process to join cluster.
  let joined = false;
  for (let i = 0; i < 60; i++) {
    try {
      const logs = runCapture(`docker logs ${FDB_CONTAINER_NAME} --tail 50`, {
        cwd: REPO_ROOT,
        stdio: "pipe",
      });
      if (logs.includes("FDBD joined cluster")) {
        joined = true;
        break;
      }
    } catch {
      // ignore and retry
    }
    sleep(500);
  }
  if (!joined) {
    throw new Error(
      "FoundationDB container did not start correctly (no 'FDBD joined cluster' log).",
    );
  }

  // Initialize database (idempotent enough for our single-run container).
  const rawStorageMode = process.env["FDB_STORAGE_MODE"] ?? "single";
  const fdbStorageMode =
    rawStorageMode === "single"
      ? "single ssd"
      : rawStorageMode === "memory"
        ? "single memory"
        : rawStorageMode;
  let initialized = false;
  for (let i = 0; i < 30; i++) {
    try {
      runCapture(
        `docker exec ${FDB_CONTAINER_NAME} fdbcli --exec "configure new ${fdbStorageMode}"`,
        {
          cwd: REPO_ROOT,
          stdio: "pipe",
        },
      );
      initialized = true;
      break;
    } catch {
      sleep(1000);
    }
  }
  if (!initialized) {
    throw new Error(`Failed to initialize FoundationDB with 'configure new ${fdbStorageMode}'.`);
  }

  // Wait for healthy status.
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const status = runCapture(
        `docker exec ${FDB_CONTAINER_NAME} fdbcli --exec "status minimal"`,
        {
          cwd: REPO_ROOT,
          stdio: "pipe",
        },
      );
      if (status.toLowerCase().includes("database is available")) {
        ready = true;
        break;
      }
    } catch {
      // ignore and retry
    }
    sleep(1000);
  }
  if (!ready) {
    throw new Error("FoundationDB did not report healthy status in time.");
  }

  // Use canonical host:port mapping (4500 -> 4500) to avoid FDB port assertions.
  writeFileSync(FDB_CLUSTER_FILE_PATH, `docker:docker@127.0.0.1:${FDB_HOST_PORT}`);
  log(`FoundationDB ready on port ${FDB_HOST_PORT}`);
  log(`  Cluster file: ${FDB_CLUSTER_FILE_PATH}`);

  // Probe host-side client connectivity.
  try {
    runCapture(
      `node -e "import('foundationdb').then(async (fdb)=>{fdb.setAPIVersion(720);const db=fdb.open(process.env.FDB_CLUSTER_FILE);await db.set(Buffer.from('__bench_probe__'), Buffer.from('1'));await db.get(Buffer.from('__bench_probe__'));db.close();}).catch((e)=>{console.error(e);process.exit(1)})"`,
      {
        cwd: FDB_PKG_DIR,
        stdio: "pipe",
        env: {
          ...(process.env as Record<string, string>),
          FDB_CLUSTER_FILE: FDB_CLUSTER_FILE_PATH,
        },
      },
    );
  } catch {
    throw new Error(
      "FoundationDB connectivity probe failed (host client could not connect to benchmark container).",
    );
  }

  return FDB_CLUSTER_FILE_PATH;
}

function stopFoundationDb() {
  heading("Stopping FoundationDB container");
  try {
    runCapture(`docker rm -f ${FDB_CONTAINER_NAME}`, { cwd: REPO_ROOT, stdio: "pipe" });
  } catch {
    warn("Failed to stop FoundationDB container (may already be stopped).");
  }

  if (existsSync(FDB_CLUSTER_FILE_PATH)) {
    rmSync(FDB_CLUSTER_FILE_PATH);
  }
}

function cleanupJsonFiles() {
  for (const backend of ["sqlite", "pg", "kv", "fdb"]) {
    const f = resolve(PKG_DIR, `benchmark-results-${backend}.json`);
    if (existsSync(f)) rmSync(f);
  }
}

function readResults(backend: string): BenchmarkResults | null {
  const f = resolve(PKG_DIR, `benchmark-results-${backend}.json`);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf-8")) as BenchmarkResults;
}

// ─── PostgreSQL lifecycle (testcontainers) ─────────────────────────────────

const PG_IMAGE = "postgres:17-alpine";
const PG_PORT = 5432;
const PG_USER = "test";
const PG_PASSWORD = "test";
const PG_DATABASE = "test_ontology";

let pgContainer: StartedTestContainer | undefined;

async function startPostgres(): Promise<string> {
  heading("Starting PostgreSQL container (testcontainers)");

  const container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASSWORD,
      POSTGRES_DB: PG_DATABASE,
    })
    .withExposedPorts(PG_PORT)
    .withTmpFs({ "/var/lib/postgresql/data": "rw" })
    .withStartupTimeout(60_000)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  pgContainer = container;
  const host = container.getHost();
  const port = container.getMappedPort(PG_PORT);
  const url = `postgresql://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DATABASE}`;

  log(`PostgreSQL ready on port ${port}`);
  log(`  URL: ${url}`);
  return url;
}

async function stopPostgres() {
  heading("Stopping PostgreSQL container");
  if (pgContainer) {
    try {
      await pgContainer.stop();
    } catch {
      warn("Failed to stop PostgreSQL container (may already be stopped).");
    }
    pgContainer = undefined;
  }
}

// ─── Run benchmarks ────────────────────────────────────────────────────────

function runBenchmark(backend: string, extraEnv: Record<string, string> = {}): boolean {
  heading(`Running ${backend.toUpperCase()} benchmark`);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    STRESS_JSON_OUTPUT: "true",
    STRESS_BACKEND: backend,
    // Default to 1M employees and 10 update rounds for the full benchmark
    STRESS_EMPLOYEE_COUNT: process.env["STRESS_EMPLOYEE_COUNT"] ?? DEFAULT_EMPLOYEE_COUNT,
    STRESS_UPDATE_ROUNDS: process.env["STRESS_UPDATE_ROUNDS"] ?? DEFAULT_UPDATE_ROUNDS,
    ...extraEnv,
  };

  // Very generous timeout: 1M employees × 10 rounds can take 30-60+ min.
  // Use runTolerant so that query assertion failures don't abort the whole
  // benchmark — the JSON results are written in afterAll regardless.
  return runTolerant("npx vitest run", { cwd: PKG_DIR, env, timeout: 7_200_000 });
}

// ─── Markdown generation ───────────────────────────────────────────────────

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtMs(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${fmt(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function generateMarkdown(results: BenchmarkResults[]): string {
  const lines: string[] = [];
  const w = (s: string) => lines.push(s);

  // Use the first result's system info (they should be identical)
  const sys = results[0]!.system;
  const employeeCount = results[0]!.employeeCount;
  const updateRounds = results[0]!.updateRounds;
  const totalTriples = results[0]!.insertion?.totalTriples ?? employeeCount * 10;

  w("---");
  w("title: Performance Benchmarks");
  w("---");
  w("");
  w("# Performance Benchmarks");
  w("");
  w(
    `> Auto-generated on ${new Date().toISOString().split("T")[0]} by \`pnpm --filter triplex-stress benchmark\`.`,
  );
  w(`> Re-run the benchmark to update these numbers for your hardware.`);
  w("");

  // ── Test Configuration ──

  w("## Test Configuration");
  w("");
  w("| Parameter | Value |");
  w("|-----------|-------|");
  w(`| Employees | ${fmt(employeeCount)} |`);
  w(`| Total triples (initial) | ~${fmt(totalTriples)} |`);
  w(`| Update rounds | ${updateRounds} |`);
  w(`| Attributes updated/round | 5 (salary, age, title, hire_date, active) |`);
  w(`| Node.js | ${sys.nodeVersion} |`);
  w(`| Platform | ${sys.platform} ${sys.arch} |`);
  w(`| CPU | ${sys.cpuModel} (${sys.cpus} cores) |`);
  w(`| Memory | ${sys.totalMemoryGB} GB |`);
  w("");

  // ── Backends tested ──

  w("## Backends Tested");
  w("");
  w("| Backend | Description |");
  w("|---------|-------------|");
  for (const r of results) {
    const desc =
      r.backend === "sqlite"
        ? "SQLite (better-sqlite3) — file-based, single-process, WAL mode"
        : r.backend === "pg"
          ? "PostgreSQL 17 — network database via Docker (tmpfs-backed)"
          : r.backend === "kv"
            ? "In-memory KV — hexastore-indexed ordered map (no SQL, no disk)"
            : r.backend === "fdb"
              ? "FoundationDB 7.3 — distributed KV via Docker + host client library"
              : r.backend;
    w(`| **${r.backend.toUpperCase()}** | ${desc} |`);
  }
  w("");

  // ── Insertion Performance ──

  w("## Insertion Performance");
  w("");

  const insertionHeaders = ["Metric", ...results.map((r) => r.backend.toUpperCase())];
  w(`| ${insertionHeaders.join(" | ")} |`);
  w(`| ${insertionHeaders.map(() => "---").join(" | ")} |`);

  const insertionRows: [string, (r: BenchmarkResults) => string][] = [
    [
      "Throughput",
      (r) => (r.insertion ? `${fmt(r.insertion.throughputTriplesPerSec)} triples/s` : "N/A"),
    ],
    ["Total time", (r) => (r.insertion ? fmtMs(r.insertion.insertionTimeMs) : "N/A")],
    ["Avg batch", (r) => (r.insertion ? fmtMs(r.insertion.avgBatchMs) : "N/A")],
    ["Min batch", (r) => (r.insertion ? fmtMs(r.insertion.minBatchMs) : "N/A")],
    ["Max batch", (r) => (r.insertion ? fmtMs(r.insertion.maxBatchMs) : "N/A")],
    [
      "Variance (max/min)",
      (r) => {
        if (!r.insertion) return "N/A";
        const v = r.insertion.variance;
        return v > 0 ? `${v}x` : "N/A";
      },
    ],
    ["Database size", (r) => r.insertion?.databaseSize ?? "N/A"],
  ];

  for (const [label, getter] of insertionRows) {
    w(`| ${label} | ${results.map(getter).join(" | ")} |`);
  }
  w("");

  // ── Update Performance ──

  const hasUpdates = results.some((r) => r.updates != null);
  if (hasUpdates) {
    w("## Update Performance");
    w("");
    w(
      `Each employee receives ${updateRounds} rounds of updates. Per round, 5 attributes are updated ` +
        "using atomic retract-then-assert transactions (retract old value, assert new value).",
    );
    w("");

    // Summary table
    const updateHeaders = ["Metric", ...results.map((r) => r.backend.toUpperCase())];
    w(`| ${updateHeaders.join(" | ")} |`);
    w(`| ${updateHeaders.map(() => "---").join(" | ")} |`);

    const updateSummaryRows: [string, (r: BenchmarkResults) => string][] = [
      ["Total updates", (r) => (r.updates ? fmt(r.updates.totalUpdates) : "N/A")],
      ["Total time", (r) => (r.updates ? fmtMs(r.updates.totalTimeMs) : "N/A")],
      [
        "Overall throughput",
        (r) => (r.updates ? `${fmt(r.updates.overallThroughputUpdatesPerSec)} updates/s` : "N/A"),
      ],
      ["DB size after updates", (r) => r.updates?.databaseSizeAfter ?? "N/A"],
    ];

    for (const [label, getter] of updateSummaryRows) {
      w(`| ${label} | ${results.map(getter).join(" | ")} |`);
    }
    w("");

    // Per-round breakdown
    w("### Per-Round Breakdown");
    w("");
    w(
      "Shows throughput per round to reveal any degradation as the number of historical rows grows.",
    );
    w("");

    const _maxRounds = Math.max(...results.map((r) => r.updates?.perRound.length ?? 0));

    for (const r of results) {
      if (!r.updates) continue;

      w(`#### ${r.backend.toUpperCase()}`);
      w("");
      w("| Round | Time | Throughput | Avg Batch | Min Batch | Max Batch |");
      w("|-------|------|------------|-----------|-----------|-----------|");

      for (const round of r.updates.perRound) {
        w(
          `| ${round.round} | ${fmtMs(round.timeMs)} | ${fmt(round.throughputUpdatesPerSec)} updates/s | ${fmtMs(round.avgBatchMs)} | ${fmtMs(round.minBatchMs)} | ${fmtMs(round.maxBatchMs)} |`,
        );
      }
      w("");
    }
  }

  // ── Triple-Pattern Query Latency ──

  w("## Triple-Pattern Query Latency");
  w("");
  const queryContext = hasUpdates
    ? `Direct \`Triples.match()\` and \`Triples.entity()\` calls after ${updateRounds} update rounds. ` +
      "Retracted rows are excluded via partial indexes, so current-state queries should be unaffected by historical data."
    : "Direct `Triples.match()` and `Triples.entity()` calls against the triple store.";
  w(queryContext);
  w("");

  const queryIds = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"];
  const qHeaders = ["Query", "Description", ...results.map((r) => r.backend.toUpperCase())];
  w(`| ${qHeaders.join(" | ")} |`);
  w(`| ${qHeaders.map(() => "---").join(" | ")} |`);

  for (const id of queryIds) {
    const firstMatch = results.flatMap((r) => r.queries).find((q) => q.id === id);
    const desc = firstMatch?.description ?? id;
    const vals = results.map((r) => {
      const q = r.queries.find((q) => q.id === id);
      return q ? fmtMs(q.durationMs) : "N/A";
    });
    w(`| ${id} | ${desc} | ${vals.join(" | ")} |`);
  }
  w("");

  // ── Datalog Query Latency ──

  w("## Datalog Query Latency");
  w("");
  w(
    "Datalog queries compiled to SQL (SQLite/PG) or executed natively against the hexastore (KV/FDB).",
  );
  w("");

  const datalogIds = ["D1", "D2", "D3", "D4", "D5", "D6"];
  const dHeaders = ["Query", "Description", ...results.map((r) => r.backend.toUpperCase())];
  w(`| ${dHeaders.join(" | ")} |`);
  w(`| ${dHeaders.map(() => "---").join(" | ")} |`);

  for (const id of datalogIds) {
    const firstMatch = results.flatMap((r) => r.queries).find((q) => q.id === id);
    const desc = firstMatch?.description ?? id;
    const vals = results.map((r) => {
      const q = r.queries.find((q) => q.id === id);
      return q ? fmtMs(q.durationMs) : "N/A";
    });
    w(`| ${id} | ${desc} | ${vals.join(" | ")} |`);
  }
  w("");

  // ── Query Descriptions ──

  w("## Query Descriptions");
  w("");
  w("### Triple-Pattern Queries (Q1-Q6)");
  w("");
  w("| ID | Pattern | What it measures |");
  w("|---|---|---|");
  w('| Q1 | `getEntity("emp:N")` | Point lookup of a single entity by ID |');
  w('| Q2 | `query({ attribute: ":salary" })` | Full scan of one attribute across all entities |');
  w('| Q3 | `query({ entityType: "Employee" })` | Filter all triples by entity type |');
  w(
    '| Q4 | `query({ attribute: ":department", value: "Engineering" })` | Composite attribute + value filter |',
  );
  w(
    '| Q5 | `query({ attribute: ":manager", value: ref("emp:0") })` | Reference traversal (follow relationship) |',
  );
  w('| Q6 | `query({ attribute: ":active", value: true })` | Boolean value filter |');
  w("");
  w("### Datalog Queries (D1-D6)");
  w("");
  w("| ID | Pattern | What it measures |");
  w("|---|---|---|");
  w("| D1 | `find: [?name], where: [[?e, :name, ?name]]` | Single pattern clause |");
  w(
    "| D2 | `find: [?name, ?dept], where: [[?e, :name, ?name], [?e, :department, ?dept]]` | Self-join on entity variable |",
  );
  w(
    "| D3 | `find: [?name, ?salary], where: [..., [>=, ?salary, 150000]]` | Numeric predicate filter |",
  );
  w(
    '| D4 | `find: [?name, ?title], where: [..., [?e, :department, "Engineering"]]` | Multi-attribute with value binding |',
  );
  w(
    "| D5 | `find: [?dept, (count ?e)], where: [[?e, :department, ?dept]]` | GROUP BY + COUNT aggregation |",
  );
  w(
    "| D6 | `find: [?empName, ?mgrName], where: [..., [?e, :manager, ?mgr], ...]` | Reference join across entities |",
  );
  w("");

  // ── Test Data ──

  w("## Test Data");
  w("");
  w(`The benchmark generates ${fmt(employeeCount)} employee records, each with ~10 attributes:`);
  w("");
  w("- **:name** — Employee name (string)");
  w("- **:email** — Email address (string)");
  w("- **:age** — Age 25-65 (number)");
  w("- **:salary** — Salary $50k-$225k, correlated with level (number)");
  w("- **:department** — 8 departments evenly distributed (string)");
  w("- **:title** — 6 seniority levels, realistic pyramid distribution (string)");
  w("- **:active** — 90% true (boolean)");
  w("- **:hire_date** — Distributed over past days (datetime)");
  w("- **:location** — 5 locations (string)");
  w("- **:manager** — 20% have manager references creating graph structure (ref)");
  w("");

  if (hasUpdates) {
    w("### Update Pattern");
    w("");
    w(
      `After initial insertion, each employee receives ${updateRounds} rounds of updates. Each round updates 5 attributes:`,
    );
    w("");
    w("- **:salary** — +$5,000 per round (raises)");
    w("- **:age** — +1 per round (aging)");
    w("- **:title** — Cycle through seniority levels (promotions)");
    w("- **:hire_date** — Shift forward 30 days per round");
    w("- **:active** — Toggle every other round");
    w("");
    w(
      `This creates ~${fmt(employeeCount * 10 + updateRounds * employeeCount * 5 * 2)} total rows in the triples table ` +
        `(${fmt(employeeCount * 10)} initial + ${fmt(updateRounds * employeeCount * 5)} retracted + ${fmt(updateRounds * employeeCount * 5)} new assertions).`,
    );
    w("");
  }

  // ── Methodology ──

  w("## Methodology");
  w("");
  w(
    "- **SQLite** runs locally with WAL mode and default PRAGMA settings (no unsafe optimizations).",
  );
  w(
    "- **PostgreSQL** runs in a Docker container (`postgres:17-alpine`) with tmpfs-backed storage.",
  );
  w(
    "- **KV** uses an in-memory ordered map with hexastore indexes. No SQL layer — Datalog runs natively against the hexastore. " +
      "Updates are skipped (no SqlClient), so KV only benchmarks insertion and queries.",
  );
  w(
    "- **FoundationDB** uses the KV hexastore backend against a Docker-hosted FDB cluster (port 4500) with a host-side FDB client library. " +
      "Like KV, updates are skipped (no SqlClient), so FDB benchmarks insertion and queries.",
  );
  w("- Insertion is batched at 1,000 employees (~10,000 triples) per batch.");
  if (hasUpdates) {
    w("- Updates use bulk SQL retract + `assertBatch` within a single transaction per batch.");
    w(
      "- Batch size: 500 employees (PG) / 1,000 employees (SQLite). Each update round modifies 5 attributes per employee.",
    );
    w("- PG batches include retry logic (up to 3 retries with 2s delay) for transient failures.");
  }
  w("- Query times are wall-clock milliseconds measured with `Date.now()`.");
  w(
    "- SQLite and PG compile Datalog to SQL. KV and FDB execute Datalog natively against the hexastore. Results are deterministic for the same dataset.",
  );
  w(
    "- Current-state queries use partial indexes (`WHERE retracted_at IS NULL`), so retracted historical rows add no overhead.",
  );
  w("");
  w("## Running the Benchmark");
  w("");
  w("```bash");
  w("# Full benchmark (SQLite + PostgreSQL + KV + FoundationDB)");
  w("pnpm --filter triplex-stress benchmark");
  w("");
  w("# Customize scale");
  w("STRESS_EMPLOYEE_COUNT=100000 STRESS_UPDATE_ROUNDS=5 pnpm --filter triplex-stress benchmark");
  w("");
  w("# Skip updates (insertion + queries only)");
  w("STRESS_UPDATE_ROUNDS=0 pnpm --filter triplex-stress benchmark");
  w("");
  w("# Skip PostgreSQL (SQLite + KV + FDB only)");
  w("BENCHMARK_SKIP_PG=true pnpm --filter triplex-stress benchmark");
  w("");
  w("# Skip KV (SQLite + PostgreSQL + FDB only)");
  w("BENCHMARK_SKIP_KV=true pnpm --filter triplex-stress benchmark");
  w("");
  w("# Skip FoundationDB (SQLite + PostgreSQL + KV only)");
  w("BENCHMARK_SKIP_FDB=true pnpm --filter triplex-stress benchmark");
  w("```");
  w("");

  return lines.join("\n");
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  heading("Triplex Benchmark Report Generator");

  const employeeCount = process.env["STRESS_EMPLOYEE_COUNT"] ?? DEFAULT_EMPLOYEE_COUNT;
  const updateRounds = process.env["STRESS_UPDATE_ROUNDS"] ?? DEFAULT_UPDATE_ROUNDS;
  log(`  Employee count: ${parseInt(employeeCount).toLocaleString()}`);
  log(`  Update rounds:  ${updateRounds}`);

  const skipPg = process.env["BENCHMARK_SKIP_PG"] === "true";
  const skipSqlite = process.env["BENCHMARK_SKIP_SQLITE"] === "true";
  const skipKv = process.env["BENCHMARK_SKIP_KV"] === "true";
  const skipFdb = process.env["BENCHMARK_SKIP_FDB"] === "true";

  if (skipPg && skipSqlite && skipKv && skipFdb) {
    fail("All backends are skipped. Nothing to benchmark.");
  }

  // Docker is required for PG and FDB benchmark containers.
  if ((!skipPg || !skipFdb) && !dockerAvailable()) {
    if (!skipPg) {
      warn("Docker is not available. Skipping PostgreSQL benchmark.");
      (process.env as Record<string, string>)["BENCHMARK_SKIP_PG"] = "true";
    }
    if (!skipFdb) {
      warn("Docker is not available. Skipping FoundationDB benchmark.");
      (process.env as Record<string, string>)["BENCHMARK_SKIP_FDB"] = "true";
    }
  }

  // FoundationDB benchmark also requires host-side FDB client libs.
  if (!skipFdb && process.env["BENCHMARK_SKIP_FDB"] !== "true" && !fdbClientAvailable()) {
    warn("FoundationDB client library is not available. Skipping FoundationDB benchmark.");
    warn("Install libfdb_c and ensure Node can import 'foundationdb'.");
    (process.env as Record<string, string>)["BENCHMARK_SKIP_FDB"] = "true";
  }

  const needsPg = !skipPg && process.env["BENCHMARK_SKIP_PG"] !== "true";
  let needsFdb = !skipFdb && process.env["BENCHMARK_SKIP_FDB"] !== "true";

  const willRunSqlite = !skipSqlite;
  const willRunKv = !skipKv;
  if (!willRunSqlite && !needsPg && !willRunKv && !needsFdb) {
    fail("No runnable backends remain after skip flags and environment checks.");
  }

  // Clean up any stale result files
  cleanupJsonFiles();

  let pgUrl: string | undefined;
  let fdbClusterFile: string | undefined;

  try {
    const runSubspace = `stress/${Date.now()}-${Math.random().toString(36).slice(2, 8)}/`;

    // Start PostgreSQL if needed
    if (needsPg) {
      pgUrl = await startPostgres();
    }

    // Start FoundationDB if needed
    if (needsFdb) {
      try {
        fdbClusterFile = startFoundationDb();
      } catch (error) {
        warn(`Failed to start FoundationDB benchmark environment: ${String(error)}`);
        warn("Skipping FoundationDB benchmark for this run.");
        stopFoundationDb();
        needsFdb = false;
      }
    }

    // Run SQLite benchmark
    if (!skipSqlite) {
      runBenchmark("sqlite", {
        STRESS_TEST_TIMEOUT: process.env["STRESS_TEST_TIMEOUT"] ?? "7200000",
      });
    }

    // Run PostgreSQL benchmark
    if (needsPg && pgUrl) {
      runBenchmark("pg", {
        DATABASE_URL: pgUrl,
        STRESS_TEST_TIMEOUT: process.env["STRESS_TEST_TIMEOUT"] ?? "7200000",
      });
    }

    // Run KV benchmark
    // KV has no SqlClient, so updates must be skipped (STRESS_UPDATE_ROUNDS=0).
    if (!skipKv) {
      runBenchmark("kv", {
        STRESS_UPDATE_ROUNDS: "0",
        STRESS_TEST_TIMEOUT: process.env["STRESS_TEST_TIMEOUT"] ?? "7200000",
        STRESS_FDB_SUBSPACE: runSubspace,
      });
    }

    // Run FDB benchmark
    // FDB follows the KV path (no SqlClient), so updates must be skipped.
    if (needsFdb) {
      runBenchmark("fdb", {
        STRESS_UPDATE_ROUNDS: "0",
        STRESS_TEST_TIMEOUT: process.env["STRESS_TEST_TIMEOUT"] ?? "7200000",
        ...(fdbClusterFile
          ? { FDB_CLUSTER_FILE: fdbClusterFile, FDB_CLUSTER_FILE_PATH: fdbClusterFile }
          : {}),
        STRESS_FDB_SUBSPACE: runSubspace,
      });
    }

    // Collect results
    const results: BenchmarkResults[] = [];

    if (!skipSqlite) {
      const sqlite = readResults("sqlite");
      if (sqlite) results.push(sqlite);
      else warn("No SQLite results found.");
    }

    if (needsPg) {
      const pg = readResults("pg");
      if (pg) results.push(pg);
      else warn("No PostgreSQL results found.");
    }

    if (!skipKv) {
      const kv = readResults("kv");
      if (kv) results.push(kv);
      else warn("No KV results found.");
    }

    if (needsFdb) {
      const fdb = readResults("fdb");
      if (fdb) results.push(fdb);
      else warn("No FoundationDB results found.");
    }

    if (results.length === 0) {
      fail("No benchmark results collected. Check test output above for errors.");
    }

    // Generate markdown
    heading("Generating performance report");
    const markdown = generateMarkdown(results);
    writeFileSync(DOCS_OUTPUT, markdown);
    log(`Report written to: ${DOCS_OUTPUT}`);
  } finally {
    // Always tear down benchmark containers
    if (needsPg) {
      await stopPostgres();
    }
    if (needsFdb) {
      stopFoundationDb();
    }

    // Clean up JSON files
    cleanupJsonFiles();
  }

  heading("Done!");
  log(`View the report at: docs/performance.md`);
}

main().catch((err) => {
  if (!(err instanceof LoggedError)) {
    console.error(err);
  }
  process.exit(1);
});
