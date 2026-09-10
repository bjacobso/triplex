import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Effect, Layer, Schedule } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { generateId } from "@triplex-build/triplex/internal";
import { EntityId, string, boolean, ref } from "@triplex-build/triplex";
import { writeFileSync } from "node:fs";
import { arch, cpus, platform, totalmem } from "node:os";
import {
  generateEmployeeTriples,
  generateUpdateTriples,
  UPDATED_ATTRIBUTES_PER_ROUND,
  UPDATED_ATTRIBUTES,
} from "../src/data-generator.js";
import {
  getBackendName,
  getEmployeeCount,
  getUpdateRounds,
  makeTestLayer,
  getThresholds,
  cleanupBefore,
  cleanupAfter,
  getDatabaseSize,
  describeBackend,
  getTriples,
  makeSqlLayer,
  getInsertBatchSize,
} from "../src/backend.js";
import type { BenchmarkResults, RoundMetrics } from "../src/benchmark-results.js";

// ============================================================================
// Backend Configuration
// ============================================================================

const BACKEND = getBackendName();
const EMPLOYEE_COUNT = getEmployeeCount();
const UPDATE_ROUNDS = getUpdateRounds();
// PG uses smaller batches to reduce parameter counts and keep individual
// transactions lightweight (less WAL pressure, lower chance of transient failures).
const UPDATE_BATCH_SIZE = BACKEND === "pg" ? 500 : 1_000;
const INSERT_BATCH_SIZE = getInsertBatchSize(BACKEND); // Employees per insertion batch
const TRIPLES_PER_EMPLOYEE = 10; // Average (9 core + ~20% have 10th manager attribute)
const TestLayer = makeTestLayer(BACKEND);
const SQL_LAYER = makeSqlLayer(BACKEND);
const thresholds = getThresholds(BACKEND);

// ============================================================================
// Stress test configuration
// ============================================================================
// STRESS_TEST_KEEP_DB=true     - Keep database after test for inspection
// STRESS_BACKEND=sqlite|pg|kv|fdb - Backend to test (default: sqlite)
// STRESS_EMPLOYEE_COUNT=N          - Number of employees to generate (default: 100000)
// STRESS_UPDATE_ROUNDS=N           - Number of update rounds (default: 10, 0 to skip)
// STRESS_INSERT_BATCH_SIZE=N       - Employees per insert batch (default: 1000, fdb default: 200)
// DATABASE_URL=...                 - PostgreSQL connection URL (required for pg backend)
// FDB_CLUSTER_FILE=/path/to/cluster - Optional FoundationDB cluster file (fdb backend)
// FDB_LOG_RETRIES=true             - Log FDB transaction retries
// ============================================================================

const JSON_OUTPUT = process.env["STRESS_JSON_OUTPUT"] === "true";
const ASSERT_PERFORMANCE = process.env["STRESS_ASSERT_PERFORMANCE"] !== "false";
// ============================================================================
// Benchmark Results Accumulator
// ============================================================================

const benchmarkResults: BenchmarkResults = {
  backend: BACKEND,
  employeeCount: EMPLOYEE_COUNT,
  updateRounds: UPDATE_ROUNDS,
  timestamp: new Date().toISOString(),
  system: {
    platform: platform(),
    arch: arch(),
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model ?? "unknown",
    totalMemoryGB: Math.round(totalmem() / 1024 / 1024 / 1024),
    nodeVersion: process.version,
  },
  insertion: null,
  updates: null,
  queries: [],
};

process.stderr.write(`\n  Backend: ${describeBackend(BACKEND)}\n`);
process.stderr.write(`  Employees: ${EMPLOYEE_COUNT.toLocaleString()}\n`);
process.stderr.write(`  Update rounds: ${UPDATE_ROUNDS}\n`);
process.stderr.write(`  Insert batch size: ${INSERT_BATCH_SIZE.toLocaleString()} employees\n`);

// ============================================================================
// Tests
// ============================================================================

describe(`Triple Store Stress Test [${BACKEND}] - ${(EMPLOYEE_COUNT * TRIPLES_PER_EMPLOYEE).toLocaleString()} Triples`, () => {
  beforeAll(
    async () => {
      await cleanupBefore(BACKEND);
    },
    Number.parseInt(process.env["STRESS_TEST_TIMEOUT"] ?? "600000", 10),
  );

  it("should insert triples efficiently", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* getTriples();

        // Generate all triples upfront
        process.stderr.write(
          `\n  Generating ${EMPLOYEE_COUNT.toLocaleString()} employees (~${(EMPLOYEE_COUNT * TRIPLES_PER_EMPLOYEE).toLocaleString()} triples)...\n`,
        );
        const startGen = Date.now();
        const allTriples = generateEmployeeTriples(EMPLOYEE_COUNT);
        const genTime = Date.now() - startGen;
        process.stderr.write(`  Generation: ${genTime}ms (${(genTime / 1000).toFixed(2)}s)\n\n`);

        // Insert in batches
        process.stderr.write(
          `  Inserting in ${Math.ceil(EMPLOYEE_COUNT / INSERT_BATCH_SIZE)} batches of ~${(INSERT_BATCH_SIZE * TRIPLES_PER_EMPLOYEE).toLocaleString()} triples...\n`,
        );
        const startInsert = Date.now();
        const batchTimes: number[] = [];
        const totalBatches = Math.ceil(EMPLOYEE_COUNT / INSERT_BATCH_SIZE);

        const startStallLogger = (batchIndex: number, batchStart: number) => {
          let delayMs = 60_000;
          let timer: NodeJS.Timeout | null = null;
          let cancelled = false;

          const schedule = () => {
            if (cancelled) return;
            timer = setTimeout(() => {
              if (cancelled) return;
              const elapsed = ((Date.now() - batchStart) / 1000).toFixed(1);
              const totalElapsed = ((Date.now() - startInsert) / 1000).toFixed(1);
              process.stderr.write(
                `  [${totalElapsed}s] Batch ${batchIndex}/${totalBatches} still running (${elapsed}s). Next log in ${(
                  delayMs / 1000
                ).toFixed(0)}s\n`,
              );
              delayMs *= 2;
              schedule();
            }, delayMs);
          };

          schedule();

          return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
          };
        };

        for (let i = 0; i < EMPLOYEE_COUNT; i += INSERT_BATCH_SIZE) {
          const batchIndex = i / INSERT_BATCH_SIZE + 1;
          const batchStart = Date.now();
          const stopStallLogger = startStallLogger(batchIndex, batchStart);
          const batch = allTriples.slice(
            i * TRIPLES_PER_EMPLOYEE,
            Math.min((i + INSERT_BATCH_SIZE) * TRIPLES_PER_EMPLOYEE, allTriples.length),
          );

          yield* triples.assertBatch(batch);
          stopStallLogger();

          const batchTime = Date.now() - batchStart;
          batchTimes.push(batchTime);

          // Log progress every 5 batches
          if (batchIndex % 5 === 0) {
            const processed = Math.min(
              (i + INSERT_BATCH_SIZE) * TRIPLES_PER_EMPLOYEE,
              allTriples.length,
            );
            const elapsed = ((Date.now() - startInsert) / 1000).toFixed(1);
            const rate = processed / ((Date.now() - startInsert) / 1000);
            process.stderr.write(
              `  [${elapsed}s] Batch ${batchIndex}/${totalBatches}: ${batchTime}ms | Total: ${processed.toLocaleString()} triples | Rate: ${rate.toFixed(0)}/s\n`,
            );
          }
        }

        const totalInsertTime = Date.now() - startInsert;

        process.stderr.write(`\n  Insertion complete!\n\n`);

        return { genTime, totalInsertTime, batchTimes, totalTriples: allTriples.length };
      }).pipe(Effect.provide(TestLayer)),
    );

    // Calculate metrics
    const { genTime, totalInsertTime, batchTimes, totalTriples } = result;
    const throughput = totalTriples / (totalInsertTime / 1000);
    const avgBatch = batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length;
    const minBatch = Math.min(...batchTimes);
    const maxBatch = Math.max(...batchTimes);
    const variance = minBatch > 0 ? maxBatch / minBatch : maxBatch > 0 ? Infinity : 1;

    // Report metrics
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  INSERTION METRICS [${BACKEND}]`);
    console.log(`${"=".repeat(60)}`);
    console.log(`Total triples:    ${totalTriples.toLocaleString()}`);
    console.log(`Generation time:  ${genTime}ms (${(genTime / 1000).toFixed(2)}s)`);
    console.log(`Insertion time:   ${totalInsertTime}ms (${(totalInsertTime / 1000).toFixed(2)}s)`);
    console.log(`Throughput:       ${throughput.toFixed(0)} triples/sec`);
    console.log(`Avg batch:        ${avgBatch.toFixed(0)}ms`);
    console.log(`Min batch:        ${minBatch}ms`);
    console.log(`Max batch:        ${maxBatch}ms`);
    console.log(`Variance:         ${variance.toFixed(2)}x`);
    console.log(`${"=".repeat(60)}\n`);

    // Get database size
    const dbSize = await getDatabaseSize(BACKEND);
    console.log(`  Database size: ${dbSize}\n`);

    // Capture benchmark results
    benchmarkResults.insertion = {
      totalTriples,
      generationTimeMs: genTime,
      insertionTimeMs: totalInsertTime,
      throughputTriplesPerSec: Math.round(throughput),
      avgBatchMs: Math.round(avgBatch),
      minBatchMs: minBatch,
      maxBatchMs: maxBatch,
      variance: Number.isFinite(variance) ? Math.round(variance * 100) / 100 : -1,
      databaseSize: dbSize,
    };

    // Assertions
    const expectedMin = EMPLOYEE_COUNT * 9; // 9 core attributes
    const expectedMax = EMPLOYEE_COUNT * 11; // 11 max (with optional manager)
    expect(totalTriples).toBeGreaterThanOrEqual(expectedMin);
    expect(totalTriples).toBeLessThanOrEqual(expectedMax);
    if (ASSERT_PERFORMANCE) {
      expect(throughput).toBeGreaterThan(thresholds.minThroughput);
      expect(totalInsertTime).toBeLessThan(thresholds.insertionTimeout);
    }
  }, 600_000); // 10 minute timeout

  // ============================================================================
  // Update Performance (retract-then-assert rounds)
  // ============================================================================

  it.skipIf(UPDATE_ROUNDS === 0 || SQL_LAYER === null)(
    `should handle ${UPDATE_ROUNDS} rounds of updates across ${EMPLOYEE_COUNT.toLocaleString()} employees`,
    async () => {
      const roundMetrics: RoundMetrics[] = [];
      const totalStart = Date.now();

      // Placeholder function based on backend dialect
      const ph = (idx: number) => (BACKEND === "pg" ? `$${idx + 1}` : "?");

      // Max retries for transient PG failures (connection drops, tmpfs pressure, etc.)
      const MAX_RETRIES = BACKEND === "pg" ? 3 : 0;
      const RETRY_DELAY_MS = 2_000;

      if (SQL_LAYER === null) {
        throw new Error("Update test requires an SQL-backed backend (sqlite or pg)");
      }
      const combinedLayer = Layer.merge(TestLayer, SQL_LAYER);
      await Effect.runPromise(
        Effect.gen(function* () {
          const triples = yield* getTriples();
          const sql = yield* SqlClient.SqlClient;

          for (let round = 1; round <= UPDATE_ROUNDS; round++) {
            process.stderr.write(
              `\n  Update round ${round}/${UPDATE_ROUNDS} (${UPDATED_ATTRIBUTES_PER_ROUND} attrs × ${EMPLOYEE_COUNT.toLocaleString()} employees)...\n`,
            );

            const roundStart = Date.now();
            const batchTimes: number[] = [];
            let updatesInRound = 0;

            for (let i = 0; i < EMPLOYEE_COUNT; i += UPDATE_BATCH_SIZE) {
              const batchStart = Date.now();
              const endIdx = Math.min(i + UPDATE_BATCH_SIZE, EMPLOYEE_COUNT);
              const batchCount = endIdx - i;

              // ── Atomic retract-then-assert wrapped in a transaction ──
              // This ensures if assertBatch fails, the retracts roll back too.
              const batchEffect = sql.withTransaction(
                Effect.gen(function* () {
                  // Bulk retract via raw SQL — one UPDATE per attribute
                  const txId = generateId();
                  const timestamp = Date.now();
                  const entityIds = Array.from({ length: batchCount }, (_, k) => `emp:${i + k}`);

                  for (const attr of UPDATED_ATTRIBUTES) {
                    const params: unknown[] = [timestamp, txId, attr, ...entityIds];
                    const placeholders = entityIds.map((_, k) => ph(k + 3)).join(", ");
                    const updateSql =
                      `UPDATE triples SET retracted_at = ${ph(0)}, retract_tx_id = ${ph(1)} ` +
                      `WHERE attribute = ${ph(2)} AND retracted_at IS NULL ` +
                      `AND entity_id IN (${placeholders})`;
                    yield* sql.unsafe(updateSql, params);
                  }

                  // Bulk assert — batchInsert's inner withTransaction becomes a SAVEPOINT
                  const newTriples = generateUpdateTriples(i, endIdx, round);
                  yield* triples.assertBatch(newTriples);
                }),
              );

              // Retry logic for transient PG failures
              if (MAX_RETRIES > 0) {
                yield* batchEffect.pipe(
                  Effect.tapError((err) =>
                    Effect.sync(() => {
                      const bn = Math.floor(i / UPDATE_BATCH_SIZE) + 1;
                      process.stderr.write(
                        `  ⚠ Batch ${bn} failed, retrying (up to ${MAX_RETRIES}x): ${String(err).slice(0, 200)}\n`,
                      );
                    }),
                  ),
                  Effect.retry(
                    Schedule.addDelay(Schedule.recurs(MAX_RETRIES), () =>
                      Effect.succeed(`${RETRY_DELAY_MS} millis`),
                    ),
                  ),
                );
              } else {
                yield* batchEffect;
              }

              updatesInRound += batchCount * UPDATED_ATTRIBUTES_PER_ROUND;
              const batchTime = Date.now() - batchStart;
              batchTimes.push(batchTime);

              // Log progress every 10 batches
              const batchNum = Math.floor(i / UPDATE_BATCH_SIZE) + 1;
              const totalBatches = Math.ceil(EMPLOYEE_COUNT / UPDATE_BATCH_SIZE);
              if (batchNum % 10 === 0 || batchNum === totalBatches) {
                const elapsed = ((Date.now() - roundStart) / 1000).toFixed(1);
                const rate = updatesInRound / ((Date.now() - roundStart) / 1000);
                process.stderr.write(
                  `  [${elapsed}s] Round ${round} batch ${batchNum}/${totalBatches}: ${batchTime}ms | Updates: ${updatesInRound.toLocaleString()} | Rate: ${rate.toFixed(0)}/s\n`,
                );
              }
            }

            const roundTime = Date.now() - roundStart;
            const roundThroughput = updatesInRound / (roundTime / 1000);
            const avgBatch = batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length;
            const minBatch = Math.min(...batchTimes);
            const maxBatch = Math.max(...batchTimes);

            console.log(
              `\n  Round ${round}: ${roundTime}ms (${(roundTime / 1000).toFixed(1)}s) | ${roundThroughput.toFixed(0)} updates/s`,
            );

            roundMetrics.push({
              round,
              timeMs: roundTime,
              throughputUpdatesPerSec: Math.round(roundThroughput),
              avgBatchMs: Math.round(avgBatch),
              minBatchMs: minBatch,
              maxBatchMs: maxBatch,
            });

            if (ASSERT_PERFORMANCE) {
              expect(roundTime).toBeLessThan(thresholds.updateRoundTimeout);
              expect(roundThroughput).toBeGreaterThan(thresholds.minUpdateThroughput);
            }
          }
        }).pipe(Effect.provide(combinedLayer)),
      );

      const totalTime = Date.now() - totalStart;
      const totalUpdates = UPDATE_ROUNDS * EMPLOYEE_COUNT * UPDATED_ATTRIBUTES_PER_ROUND;
      const overallThroughput = totalUpdates / (totalTime / 1000);

      // Report summary
      console.log(`\n${"=".repeat(60)}`);
      console.log(`  UPDATE METRICS [${BACKEND}]`);
      console.log(`${"=".repeat(60)}`);
      console.log(`Rounds:           ${UPDATE_ROUNDS}`);
      console.log(`Attrs/update:     ${UPDATED_ATTRIBUTES_PER_ROUND}`);
      console.log(`Total updates:    ${totalUpdates.toLocaleString()}`);
      console.log(`Total time:       ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)`);
      console.log(`Overall rate:     ${overallThroughput.toFixed(0)} updates/sec`);
      console.log(`${"=".repeat(60)}\n`);

      const dbSizeAfter = await getDatabaseSize(BACKEND);
      console.log(`  Database size after updates: ${dbSizeAfter}\n`);

      benchmarkResults.updates = {
        rounds: UPDATE_ROUNDS,
        attributesPerUpdate: UPDATED_ATTRIBUTES_PER_ROUND,
        totalUpdates,
        totalTimeMs: totalTime,
        overallThroughputUpdatesPerSec: Math.round(overallThroughput),
        perRound: roundMetrics,
        databaseSizeAfter: dbSizeAfter,
      };
    },
    UPDATE_ROUNDS * 1_200_000, // Generous timeout: 20 min per round
  );

  // ============================================================================
  // Triple-pattern query performance
  // ============================================================================

  describe("Triple-Pattern Query Performance", () => {
    it("Q1: Single entity lookup", async () => {
      const targetId = `emp:${Math.floor(EMPLOYEE_COUNT / 2)}`;
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const triples = yield* getTriples();
          return yield* triples.entity(targetId as EntityId);
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      console.log(`Q1 - Entity lookup: ${duration}ms (${result.length} triples)`);
      benchmarkResults.queries.push({
        id: "Q1",
        description: "Single entity lookup",
        durationMs: duration,
        resultCount: result.length,
      });
      expect(result.length).toBeGreaterThanOrEqual(9);
      expect(result.length).toBeLessThanOrEqual(10);
      if (ASSERT_PERFORMANCE) expect(duration).toBeLessThan(thresholds.entityLookup);
    });

    it("Q2: Query by attribute", async () => {
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const triples = yield* getTriples();
          return yield* triples.match({ attribute: ":salary" });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      console.log(`Q2 - Attribute scan: ${duration}ms (${result.length} results)`);
      benchmarkResults.queries.push({
        id: "Q2",
        description: "Attribute scan",
        durationMs: duration,
        resultCount: result.length,
      });
      expect(result.length).toBe(EMPLOYEE_COUNT);
      if (ASSERT_PERFORMANCE) expect(duration).toBeLessThan(thresholds.attributeScan);
    });

    it("Q3: Query by entity type", async () => {
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const triples = yield* getTriples();
          return yield* triples.match({ entityType: "Employee" });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      console.log(`Q3 - Type filter: ${duration}ms (${result.length} results)`);
      benchmarkResults.queries.push({
        id: "Q3",
        description: "Entity type filter",
        durationMs: duration,
        resultCount: result.length,
      });
      expect(result.length).toBe(EMPLOYEE_COUNT);
      if (ASSERT_PERFORMANCE) expect(duration).toBeLessThan(thresholds.typeFilter);
    });

    it("Q4: Query by specific value", async () => {
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const triples = yield* getTriples();
          return yield* triples.match({
            attribute: ":department",
            value: string("Engineering"),
          });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      // With modulo distribution, each department gets ceil or floor of count/8
      const expectedMin = Math.floor(EMPLOYEE_COUNT / 8);
      const expectedMax = Math.ceil(EMPLOYEE_COUNT / 8);
      console.log(`Q4 - Value filter: ${duration}ms (${result.length} results)`);
      benchmarkResults.queries.push({
        id: "Q4",
        description: "Specific value filter",
        durationMs: duration,
        resultCount: result.length,
      });
      expect(result.length).toBeGreaterThanOrEqual(expectedMin);
      expect(result.length).toBeLessThanOrEqual(expectedMax);
      if (ASSERT_PERFORMANCE) expect(duration).toBeLessThan(thresholds.valueFilter);
    });

    it("Q5: Follow reference", async () => {
      // Use a manager ID that exists at any scale: emp:0 is referenced by emp:10's manager
      // (managerId = max(0, 10 - 10 - 0) = 0 for i=10)
      const mgrId = EntityId.make(EMPLOYEE_COUNT > 10 ? "emp:0" : "emp:0");
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const triples = yield* getTriples();
          return yield* triples.match({
            attribute: ":manager",
            value: ref(mgrId),
          });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      console.log(`Q5 - Reference lookup: ${duration}ms (${result.length} results)`);
      benchmarkResults.queries.push({
        id: "Q5",
        description: "Reference lookup",
        durationMs: duration,
        resultCount: result.length,
      });
      // At least some employees should reference this manager (if count > 10)
      if (EMPLOYEE_COUNT > 10) {
        expect(result.length).toBeGreaterThan(0);
      }
      if (ASSERT_PERFORMANCE) expect(duration).toBeLessThan(thresholds.refLookup);
    });

    it("Q6: Get all active employees", async () => {
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const triples = yield* getTriples();
          return yield* triples.match({
            attribute: ":active",
            value: boolean(true),
          });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      // After updates, active employees count depends on round parity
      // Odd rounds toggle, even rounds restore. With UPDATE_ROUNDS updates:
      // If UPDATE_ROUNDS > 0 and odd: all toggled; if even: back to original
      const baseExpected = EMPLOYEE_COUNT - Math.floor(EMPLOYEE_COUNT / 10); // 90% active
      console.log(`Q6 - Boolean filter: ${duration}ms (${result.length} results)`);
      benchmarkResults.queries.push({
        id: "Q6",
        description: "Boolean filter",
        durationMs: duration,
        resultCount: result.length,
      });
      // After updates, active count changes so just verify it's reasonable
      if (UPDATE_ROUNDS === 0) {
        expect(result.length).toBe(baseExpected);
      } else {
        expect(result.length).toBeGreaterThan(0);
        expect(result.length).toBeLessThanOrEqual(EMPLOYEE_COUNT);
      }
      if (ASSERT_PERFORMANCE) expect(duration).toBeLessThan(thresholds.booleanFilter);
    });
  });

  // ============================================================================
  // Datalog Query Performance
  // ============================================================================

  describe("Datalog Query Performance", () => {
    it("D1: Simple pattern - find all names", async () => {
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const triples = yield* getTriples();
          return yield* triples.queryAll({
            find: ["?name"],
            where: [["?e", ":name", "?name"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      console.log(`D1 - Simple pattern: ${duration}ms (${result.results.length} results)`);
      benchmarkResults.queries.push({
        id: "D1",
        description: "Simple pattern",
        durationMs: duration,
        resultCount: result.results.length,
      });
      expect(result.results.length).toBe(EMPLOYEE_COUNT);
      if (ASSERT_PERFORMANCE) expect(duration).toBeLessThan(thresholds.datalogSimple);
    });

    it("D2: Two-variable join - name + department", async () => {
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const triples = yield* getTriples();
          return yield* triples.queryAll({
            find: ["?name", "?dept"],
            where: [
              ["?e", ":name", "?name"],
              ["?e", ":department", "?dept"],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      console.log(`D2 - Two-variable join: ${duration}ms (${result.results.length} results)`);
      benchmarkResults.queries.push({
        id: "D2",
        description: "Two-variable join",
        durationMs: duration,
        resultCount: result.results.length,
      });
      expect(result.results.length).toBe(EMPLOYEE_COUNT);
      if (ASSERT_PERFORMANCE) expect(duration).toBeLessThan(thresholds.datalogJoin);
    });

    it("D3: Predicate filter - salary >= threshold", async () => {
      // Salary formula: baseSalary = 50000 + titleIdx * 25000 + (i % 50000)
      //   titleIdx = min(floor(i / 20000), 5)
      //   After updates: salary += 5000 * round (using final UPDATE_ROUNDS value)
      // Compute actual min/max based on EMPLOYEE_COUNT
      const maxTitleIdx = Math.min(Math.floor((EMPLOYEE_COUNT - 1) / 20000), 5);
      const maxIModulo = Math.min(EMPLOYEE_COUNT - 1, 49999);
      const actualMaxSalary = 50000 + maxTitleIdx * 25000 + maxIModulo + 5000 * UPDATE_ROUNDS;
      const actualMinSalary = 50000 + 5000 * UPDATE_ROUNDS; // i=0: titleIdx=0, i%50000=0
      // Pick threshold at ~75th percentile to get a meaningful subset
      const salaryThreshold = Math.floor(
        actualMinSalary + (actualMaxSalary - actualMinSalary) * 0.25,
      );
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const triples = yield* getTriples();
          return yield* triples.queryAll({
            find: ["?name", "?salary"],
            where: [
              ["?e", ":name", "?name"],
              ["?e", ":salary", "?salary"],
              [">=", "?salary", salaryThreshold],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      console.log(`D3 - Predicate filter: ${duration}ms (${result.results.length} results)`);
      benchmarkResults.queries.push({
        id: "D3",
        description: "Predicate filter",
        durationMs: duration,
        resultCount: result.results.length,
      });
      // Some employees should have salary >= threshold
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.length).toBeLessThanOrEqual(EMPLOYEE_COUNT);
      if (ASSERT_PERFORMANCE) expect(duration).toBeLessThan(thresholds.datalogPredicate);
    });

    it("D4: Multi-attribute with value binding - Engineering employees", async () => {
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const triples = yield* getTriples();
          return yield* triples.queryAll({
            find: ["?name", "?title"],
            where: [
              ["?e", ":name", "?name"],
              ["?e", ":department", "Engineering"],
              ["?e", ":title", "?title"],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      // With modulo distribution, each department gets ceil or floor of count/8
      const expectedMin = Math.floor(EMPLOYEE_COUNT / 8);
      const expectedMax = Math.ceil(EMPLOYEE_COUNT / 8);
      console.log(`D4 - Multi-attribute: ${duration}ms (${result.results.length} results)`);
      benchmarkResults.queries.push({
        id: "D4",
        description: "Multi-attribute with value binding",
        durationMs: duration,
        resultCount: result.results.length,
      });
      expect(result.results.length).toBeGreaterThanOrEqual(expectedMin);
      expect(result.results.length).toBeLessThanOrEqual(expectedMax);
      if (ASSERT_PERFORMANCE) expect(duration).toBeLessThan(thresholds.datalogMultiAttr);
    });

    it("D5: Aggregation - count per department", async () => {
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const triples = yield* getTriples();
          return yield* triples.queryAll({
            find: ["?dept", "?count"],
            where: [["?e", ":department", "?dept"]],
            aggregate: [["count", "?e", "?count"]],
          });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      console.log(`D5 - Aggregation: ${duration}ms (${result.results.length} rows)`);
      benchmarkResults.queries.push({
        id: "D5",
        description: "Aggregation (count per department)",
        durationMs: duration,
        resultCount: result.results.length,
      });
      expect(result.results.length).toBe(8); // 8 departments
      if (ASSERT_PERFORMANCE) expect(duration).toBeLessThan(thresholds.datalogAggregation);
    });

    it("D6: Reference traversal - employee + manager name", async () => {
      const start = Date.now();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const triples = yield* getTriples();
          return yield* triples.queryAll({
            find: ["?empName", "?mgrName"],
            where: [
              ["?e", ":name", "?empName"],
              ["?e", ":manager", "?mgr"],
              ["?mgr", ":name", "?mgrName"],
            ],
          });
        }).pipe(Effect.provide(TestLayer)),
      );
      const duration = Date.now() - start;

      // ~20% of employees have manager refs
      const expectedMin = Math.floor(EMPLOYEE_COUNT * 0.15);
      const expectedMax = Math.floor(EMPLOYEE_COUNT * 0.25);
      console.log(`D6 - Ref traversal: ${duration}ms (${result.results.length} results)`);
      benchmarkResults.queries.push({
        id: "D6",
        description: "Reference traversal",
        durationMs: duration,
        resultCount: result.results.length,
      });
      expect(result.results.length).toBeGreaterThanOrEqual(expectedMin);
      expect(result.results.length).toBeLessThanOrEqual(expectedMax);
      if (ASSERT_PERFORMANCE) expect(duration).toBeLessThan(thresholds.datalogRefTraversal);
    });
  });

  afterAll(async () => {
    // Write structured JSON results for the benchmark report generator
    if (JSON_OUTPUT) {
      const outputPath = `./benchmark-results-${BACKEND}.json`;
      writeFileSync(outputPath, JSON.stringify(benchmarkResults, null, 2));
      process.stderr.write(`\n  Benchmark results written to: ${outputPath}\n`);
    }

    await cleanupAfter(BACKEND);
  });
});
