/** Opt-in Postgres allocation benchmark. Only generated schemas are created/dropped. */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { cpus, platform, arch, totalmem } from "node:os";
import { randomUUID } from "node:crypto";
import { Context, Effect, Layer, Redacted, Result } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { DatabaseId, EntityId, number, Triples } from "@triplex-build/triplex";
import {
  databaseToSchema,
  PgTriples,
  type PostgresqlConfig,
} from "@triplex-build/triplex-postgres";
import { GenericContainer, Wait } from "testcontainers";

const integer = (name: string, fallback: number, min: number, max: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer in ${min}..${max}`);
  return value;
};
const commandsPerWriter = integer("TX1_BENCH_COMMANDS", 50, 1, 10_000);
const repetitions = integer("TX1_BENCH_REPETITIONS", 3, 1, 20);
const holdMs = integer("TX1_BENCH_HOLD_MS", 5, 0, 1_000);
const maxRetries = integer("TX1_BENCH_RETRIES", 0, 0, 100);
const sampleMs = integer("TX1_BENCH_SAMPLE_MS", 5, 1, 1_000);
const startedAt = new Date().toISOString();
const isolationLevels = ["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"] as const;
const concurrencyLevels = [1, 4, 16] as const;
type Isolation = (typeof isolationLevels)[number];

/** Read SQLSTATE through Triplex/Effect wrappers, without relying on message text. */
const sqlFailure = (error: unknown): { code: string | undefined; allocation: boolean } => {
  const pending = [error];
  const visited = new Set<unknown>();
  let code: string | undefined;
  let allocation = false;
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || visited.has(value)) continue;
    visited.add(value);
    if ("code" in value && typeof value.code === "string" && /^[0-9A-Z]{5}$/.test(value.code))
      code = value.code;
    // Location only: retryability is still classified by SQLSTATE, never text.
    if ("message" in value && String(value.message).includes("allocate commit position"))
      allocation = true;
    if ("cause" in value) pending.push(value.cause);
    if ("reason" in value) pending.push(value.reason);
  }
  return { code, allocation };
};

const percentile = (values: readonly number[], percentile: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentile))] ?? 0;
};

const program = Effect.gen(function* () {
  const suppliedUrl = process.env["PG_BENCH_URL"];
  const image = process.env["PG_BENCH_IMAGE"] ?? "postgres:17-alpine";
  let url: string;
  if (suppliedUrl) url = suppliedUrl;
  else {
    const container = yield* Effect.acquireRelease(
      Effect.promise(() =>
        new GenericContainer(image)
          .withEnvironment({
            POSTGRES_USER: "bench",
            POSTGRES_PASSWORD: "bench",
            POSTGRES_DB: "bench",
          })
          .withExposedPorts(5432)
          .withTmpFs({ "/var/lib/postgresql/data": "rw" })
          .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
          .start(),
      ),
      (container) => Effect.promise(() => container.stop()),
    );
    url = `postgresql://bench:bench@${container.getHost()}:${container.getMappedPort(5432)}/bench`;
  }
  const parsed = new URL(url);
  const adminContext = yield* Layer.build(PgClient.layer({ url: Redacted.make(url) }));
  const admin = Context.get(adminContext, SqlClient.SqlClient);
  const [version] = yield* admin<{ server_version: string }>`SHOW server_version`;
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);

  const run = (isolation: Isolation, writers: number, repetition: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = DatabaseId.make(
          `tx1-${runId}-${repetition}-${writers}-${isolation.toLowerCase().replaceAll(" ", "-")}`,
        );
        const schema = databaseToSchema(database);
        // Registered before pool/layer acquisition so cleanup also covers setup failure.
        yield* Effect.addFinalizer(() =>
          admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).pipe(Effect.orDie),
        );
        const config: PostgresqlConfig = {
          host: parsed.hostname,
          port: Number(parsed.port || 5432),
          database: decodeURIComponent(parsed.pathname.slice(1)),
          username: decodeURIComponent(parsed.username),
          password: Redacted.make(decodeURIComponent(parsed.password)),
          ssl:
            parsed.searchParams.get("sslmode") === "require" ||
            parsed.searchParams.get("ssl") === "true",
          pool: { min: writers + 1, max: writers + 2 },
        };
        const context = yield* Layer.build(PgTriples.layerForDatabaseMigrated(config, database));
        const sql = Context.get(context, SqlClient.SqlClient);
        const triples = Context.get(context, Triples);
        yield* sql`CREATE TABLE host_homes (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)`;
        yield* sql`CREATE TABLE host_outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
        for (let writer = 0; writer < writers; writer++)
          yield* sql`INSERT INTO host_homes VALUES (${writer}, 0)`;
        // Open/warm all worker and observer connections outside the measurement.
        yield* Effect.all(
          Array.from({ length: writers + 1 }, () => sql`SELECT pg_sleep(0.01)`),
          { concurrency: "unbounded" },
        );
        const label = `tx1:${runId}:${repetition}:${writers}:${isolation}`;
        let done = false;
        let commits = 0;
        let attempts = 0;
        let retried = 0;
        let failedCommands = 0;
        let serializationFailures = 0;
        let deadlocks = 0;
        const failures: Record<string, number> = {};
        const waits: Record<string, number> = {};
        let allocationLockSamples = 0;
        let otherLockSamples = 0;
        let blockedSessions = 0;
        let samples = 0;
        let visibilityChecks = 0;
        let observedHead = 0;
        let maxBlocked = 0;
        const transactionMs: number[] = [];
        const allocationAndTriplesMs: number[] = [];

        const observe = Effect.gen(function* () {
          while (!done) {
            const activity = yield* admin<{
              wait_event_type: string | null;
              wait_event: string | null;
              query: string;
              blockers: number;
            }>`SELECT wait_event_type, wait_event, query, cardinality(pg_blocking_pids(pid)) AS blockers
           FROM pg_stat_activity WHERE application_name = ${label}`;
            samples++;
            let blockedNow = 0;
            for (const row of activity) {
              if (row.wait_event_type) {
                const key = `${row.wait_event_type}:${row.wait_event}`;
                waits[key] = (waits[key] ?? 0) + 1;
              }
              if (Number(row.blockers) > 0) {
                blockedSessions++;
                blockedNow++;
              }
              if (row.wait_event_type === "Lock") {
                if (row.query.includes("triplex_commit_position")) allocationLockSamples++;
                else otherLockSamples++;
              }
            }
            maxBlocked = Math.max(maxBlocked, blockedNow);
            // A single statement observes one MVCC snapshot: no head without its
            // complete journal prefix. This is evidence, not a replacement for tests.
            const [view] = yield* sql<{
              head: number | string;
              entries: number | string;
              latest: number | string | null;
            }>`SELECT COALESCE((SELECT position FROM triplex_commit_position WHERE singleton = 1), 0) AS head,
             (SELECT COUNT(DISTINCT value_number) FROM triples WHERE attribute = ':_tx/position') AS entries,
             (SELECT MAX(value_number) FROM triples WHERE attribute = ':_tx/position') AS latest`;
            if (
              Number(view!.head) < observedHead ||
              Number(view!.head) !== Number(view!.entries) ||
              Number(view!.head) !== Number(view!.latest ?? 0)
            )
              return yield* Effect.fail(new Error(`Visibility hole: ${JSON.stringify(view)}`));
            visibilityChecks++;
            observedHead = Number(view!.head);
            yield* Effect.sleep(sampleMs);
          }
        });

        const workers = Effect.forEach(
          Array.from({ length: writers }, (_, writer) => writer),
          (writer) =>
            Effect.gen(function* () {
              for (let command = 0; command < commandsPerWriter; command++) {
                for (let retry = 0; ; retry++) {
                  attempts++;
                  let stage = "begin";
                  const started = performance.now();
                  const outcome = yield* sql
                    .withTransaction(
                      Effect.gen(function* () {
                        yield* sql.unsafe(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
                        yield* sql`SELECT set_config('application_name', ${label}, true)`;
                        stage = "host-read";
                        yield* sql`SELECT version FROM host_homes WHERE id = ${writer}`;
                        stage = "triples";
                        const allocated = performance.now();
                        yield* triples.transact(
                          [
                            {
                              op: "assert",
                              entityId: EntityId.make(`home:${writer}`),
                              attribute: ":bench/command",
                              value: number(command),
                            },
                          ],
                          { commandId: `writer:${writer}:command:${command}` },
                        );
                        allocationAndTriplesMs.push(performance.now() - allocated);
                        stage = "host-write";
                        yield* sql`UPDATE host_homes SET version = version + 1 WHERE id = ${writer}`;
                        yield* sql`INSERT INTO host_outbox VALUES (${`${writer}:${command}`}, 'intent')`;
                        stage = "hold-after-allocation";
                        if (holdMs > 0) yield* Effect.sleep(holdMs);
                        stage = "outer-commit";
                      }),
                    )
                    .pipe(Effect.result);
                  transactionMs.push(performance.now() - started);
                  if (Result.isSuccess(outcome)) {
                    commits++;
                    break;
                  }
                  const failure = sqlFailure(outcome.failure);
                  const code = failure.code ?? "unknown";
                  const location = failure.allocation ? "position-allocation" : stage;
                  const key = `${code}:${location}`;
                  failures[key] = (failures[key] ?? 0) + 1;
                  if (code === "40001") serializationFailures++;
                  else if (code === "40P01") deadlocks++;
                  else return yield* Effect.fail(outcome.failure);
                  if (retry >= maxRetries) {
                    failedCommands++;
                    break;
                  }
                  retried++;
                }
              }
            }),
          { concurrency: "unbounded" },
        );

        const started = performance.now();
        yield* Effect.all(
          [
            observe,
            workers.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  done = true;
                }),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        );
        const elapsedMs = performance.now() - started;
        const head = yield* triples.currentPosition();
        const [outbox] = yield* sql<{
          count: number | string;
        }>`SELECT COUNT(*) AS count FROM host_outbox`;
        const [homes] = yield* sql<{
          total: number | string;
        }>`SELECT SUM(version) AS total FROM host_homes`;
        const [facts] = yield* sql<{ facts: number | string; receipts: number | string }>`
          SELECT (SELECT COUNT(*) FROM triples WHERE attribute = ':bench/command') AS facts,
            (SELECT COUNT(*) FROM triplex_command_receipts) AS receipts
        `;
        if (
          head !== commits ||
          Number(outbox!.count) !== commits ||
          Number(homes!.total) !== commits ||
          Number(facts!.facts) !== commits ||
          Number(facts!.receipts) !== commits
        )
          return yield* Effect.fail(
            new Error("Facts/journal/position/host effects did not commit atomically"),
          );
        const result = {
          isolation,
          writers,
          repetition,
          commands: writers * commandsPerWriter,
          attempts,
          commits,
          failedCommands,
          retries: retried,
          serializationFailures,
          deadlocks,
          failures,
          elapsedMs,
          commitsPerSecond: (commits * 1000) / elapsedMs,
          transactionMs: {
            p50: percentile(transactionMs, 0.5),
            p95: percentile(transactionMs, 0.95),
          },
          allocationAndTriplesMs: {
            p50: percentile(allocationAndTriplesMs, 0.5),
            p95: percentile(allocationAndTriplesMs, 0.95),
          },
          waits: {
            samples,
            sessionsByEvent: waits,
            allocationLockSamples,
            otherLockSamples,
            blockedSessions,
            maxBlocked,
          },
          visibilityChecks,
          finalPosition: head,
        };
        console.error(
          JSON.stringify({
            isolation,
            writers,
            repetition,
            commits,
            serializationFailures,
            deadlocks,
            commitsPerSecond: Math.round(result.commitsPerSecond),
            allocationLockSamples,
          }),
        );
        return result;
      }),
    );

  const measurements = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    // Rotate configurations across rounds to reduce fixed-order warmup bias.
    const cases = isolationLevels.flatMap((isolation) =>
      concurrencyLevels.map((writers) => ({ isolation, writers })),
    );
    const offset = ((repetition - 1) * 3) % cases.length;
    for (const { isolation, writers } of [...cases.slice(offset), ...cases.slice(0, offset)])
      measurements.push(yield* run(isolation, writers, repetition));
  }
  return {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    trackedSourceDirty:
      execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        encoding: "utf8",
      }).trim().length > 0,
    startedAt,
    environment: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      cpuCount: cpus().length,
      memoryBytes: totalmem(),
      postgres: version!.server_version,
      postgresImage: suppliedUrl ? "external service" : image,
      endpoint: `${parsed.hostname}:${parsed.port || 5432}`,
    },
    workload: {
      commandsPerWriter,
      repetitions,
      holdMs,
      maxRetries,
      sampleMs,
      notes:
        "Disjoint home rows/entities; host read, Triplex facts/command receipt, host version/outbox write, then outer transaction hold. Setup/pool warmup excluded; observer runs during timing.",
    },
    measurements,
  };
});

const result = await Effect.runPromise(program.pipe(Effect.scoped));
const json = JSON.stringify(result, null, 2) + "\n";
if (process.env["TX1_BENCH_OUTPUT"]) writeFileSync(process.env["TX1_BENCH_OUTPUT"], json);
else console.log(json);
