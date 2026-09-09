# triplex-stress

Performance and stress tests for the Triplex triple store at scale, supporting multiple storage backends.

## Overview

These tests validate that each storage backend can handle production workloads by:

- Inserting ~10 million triples (1M employee records × 10 attributes)
- Running 10 rounds of updates (retract-then-assert) across 5 attributes per employee
- Running common triple-pattern reads (Q1-Q6)
- Running Datalog query patterns including joins, predicates, aggregations, and reference traversal (D1-D6)
- Measuring insertion, update, and query throughput with backend-specific thresholds
- Identifying performance bottlenecks across backends

Tests use `DatabaseManager` — the same public API that production code uses — to construct the `Triples` service.

## Supported Backends

| Backend  | Engine                      | Storage          | Use Case                                                                   |
| -------- | --------------------------- | ---------------- | -------------------------------------------------------------------------- |
| `sqlite` | SQLite (better-sqlite3)     | File-based       | Default. Production single-node deployments.                               |
| `pg`     | PostgreSQL (@effect/sql-pg) | Network database | Production multi-node deployments. Requires running PG server.             |
| `kv`     | In-memory KV + hexastore    | Memory only      | Fast local algorithm benchmark (no SQL layer).                             |
| `fdb`    | FoundationDB KV + hexastore | Distributed KV   | Distributed KV benchmark (requires FoundationDB cluster + client library). |

## Benchmark Report

Generate a multi-backend performance report at `docs/performance.md`:

```bash
# Full benchmark (SQLite + PostgreSQL + KV + FoundationDB)
pnpm --filter triplex-stress benchmark

# Customize scale
STRESS_EMPLOYEE_COUNT=100000 STRESS_UPDATE_ROUNDS=5 pnpm --filter triplex-stress benchmark

# Skip updates (insertion + queries only)
STRESS_UPDATE_ROUNDS=0 pnpm --filter triplex-stress benchmark

# SQLite-only (no Docker, no FDB client required)
BENCHMARK_SKIP_PG=true BENCHMARK_SKIP_KV=true BENCHMARK_SKIP_FDB=true \
  pnpm --filter triplex-stress benchmark

# Skip FoundationDB only
BENCHMARK_SKIP_FDB=true pnpm --filter triplex-stress benchmark
```

**Requirements**: Docker (for PostgreSQL and FoundationDB containers).

> Note: FoundationDB benchmarking also requires host-side FoundationDB client libraries (`libfdb_c`). Use `BENCHMARK_SKIP_FDB=true` to disable it.

The generated report includes insertion throughput, update throughput with per-round breakdown, triple-pattern latency (Q1-Q6), and Datalog query latency (D1-D6) with system information and methodology notes.

## Running Tests

### SQLite (default)

```bash
# Default - no optimizations
pnpm --filter triplex-stress stress-test

# With index dropping optimization (3-5x faster insertion, SQLite only)
STRESS_DROP_INDEXES=true pnpm --filter triplex-stress stress-test

# With unsafe PRAGMA settings (1.2-2x faster, data loss risk, SQLite only)
STRESS_UNSAFE_MODE=true pnpm --filter triplex-stress stress-test

# Both optimizations (maximum speed)
STRESS_DROP_INDEXES=true STRESS_UNSAFE_MODE=true pnpm --filter triplex-stress stress-test

# Keep database after test for inspection
STRESS_TEST_KEEP_DB=true pnpm --filter triplex-stress stress-test
```

### PostgreSQL

Requires a running PostgreSQL server:

```bash
# Run against PostgreSQL
STRESS_BACKEND=pg DATABASE_URL=postgresql://user:pass@localhost:5432/effect_triples_stress \
  pnpm --filter triplex-stress stress-test

# With fewer employees to speed things up
STRESS_BACKEND=pg DATABASE_URL=postgresql://user:pass@localhost:5432/effect_triples_stress \
  STRESS_EMPLOYEE_COUNT=50000 pnpm --filter triplex-stress stress-test
```

### KV / FoundationDB

KV-family backends (`kv`, `fdb`) do not expose a SQL layer, so update rounds are disabled (`STRESS_UPDATE_ROUNDS=0`).

```bash
# In-memory KV benchmark
pnpm --filter triplex-stress stress-test:kv

# FoundationDB benchmark (requires libfdb_c + reachable cluster)
STRESS_BACKEND=fdb STRESS_UPDATE_ROUNDS=0 FDB_CLUSTER_FILE=/path/to/fdb.cluster \
  pnpm --filter triplex-stress stress-test

# Convenience script (still requires FDB_CLUSTER_FILE or default local cluster)
FDB_CLUSTER_FILE=/path/to/fdb.cluster pnpm --filter triplex-stress stress-test:fdb
```

### FoundationDB large-scale benchmark recipe

Use this when re-running the 100k employee (1M triple) benchmark locally. On Apple Silicon, prefer the arm64 FoundationDB image.

```bash
# 100k employees, insert + query only (no SQL update rounds)
FDB_IMAGE=foundationdb/foundationdb:7.3.75 \
FDB_PLATFORM=linux/arm64 \
STRESS_EMPLOYEE_COUNT=100000 \
STRESS_UPDATE_ROUNDS=0 \
STRESS_TEST_TIMEOUT=7200000 \
STRESS_INSERT_BATCH_SIZE=200 \
FDB_MAX_TX_ENTRIES=1000 \
FDB_LOG_RETRIES=true \
FDB_STORAGE_MODE=single \
BENCHMARK_SKIP_SQLITE=true BENCHMARK_SKIP_PG=true BENCHMARK_SKIP_KV=true \
  pnpm --filter triplex-stress benchmark

# Tail the benchmark logs when running via nohup
: > /tmp/fdb-benchmark-100k.log
nohup env FDB_IMAGE=foundationdb/foundationdb:7.3.75 FDB_PLATFORM=linux/arm64 \
  STRESS_EMPLOYEE_COUNT=100000 STRESS_UPDATE_ROUNDS=0 STRESS_TEST_TIMEOUT=7200000 \
  STRESS_INSERT_BATCH_SIZE=200 FDB_MAX_TX_ENTRIES=1000 FDB_LOG_RETRIES=true \
  FDB_STORAGE_MODE=single BENCHMARK_SKIP_SQLITE=true BENCHMARK_SKIP_PG=true \
  BENCHMARK_SKIP_KV=true pnpm --filter triplex-stress benchmark \
  >> /tmp/fdb-benchmark-100k.log 2>&1 &

tail -f /tmp/fdb-benchmark-100k.log
```

### Watch Mode

```bash
# Re-runs on file changes (useful during development)
pnpm --filter triplex-stress test:watch
```

## Environment Variables

| Variable                    | Default                            | Description                                                                                                                     |
| --------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `STRESS_BACKEND`            | `sqlite`                           | Backend to test: `sqlite`, `pg`, `kv`, or `fdb`                                                                                 |
| `STRESS_EMPLOYEE_COUNT`     | `100000`                           | Number of employees to generate. Each produces ~10 triples. Benchmark script defaults to 1,000,000.                             |
| `STRESS_UPDATE_ROUNDS`      | `10`                               | Number of update rounds. Each round updates 5 attributes per employee. Set to `0` to skip (required for `kv`/`fdb`).            |
| `STRESS_ASSERT_PERFORMANCE` | `true`                             | Set to `false` for functional smoke runs that should not enforce machine-specific latency thresholds.                           |
| `DATABASE_URL`              | _(empty)_                          | PostgreSQL connection URL. **Required** when `STRESS_BACKEND=pg`.                                                               |
| `FDB_CLUSTER_FILE`          | _(empty)_                          | FoundationDB cluster file path. Optional for `fdb` backend (uses FDB default if unset).                                         |
| `FDB_IMAGE`                 | `foundationdb/foundationdb:7.3.75` | Docker image tag used by `pnpm --filter triplex-stress benchmark` for FoundationDB.                                             |
| `FDB_PLATFORM`              | `linux/amd64`                      | Docker platform override for FoundationDB (use `linux/arm64` when an ARM image is available).                                   |
| `FDB_API_VERSION`           | `720`                              | Optional FoundationDB API version override.                                                                                     |
| `FDB_MAX_TX_ENTRIES`        | `5000`                             | Max key-value entries per FDB transaction in bulk insert. Tune lower for large values, higher for small ones.                   |
| `STRESS_FDB_SUBSPACE`       | _(auto)_                           | Optional fixed FoundationDB subspace prefix. Defaults to a unique per-run prefix.                                               |
| `STRESS_DROP_INDEXES`       | `false`                            | Drop indexes before bulk insert, recreate after. SQLite only. ~3-5x speedup.                                                    |
| `STRESS_UNSAFE_MODE`        | `false`                            | Use `PRAGMA synchronous=OFF` and `journal_mode=MEMORY`. SQLite only. ~1.2-2x speedup. **WARNING: Data loss possible on crash.** |
| `STRESS_TEST_KEEP_DB`       | `false`                            | Keep the test database for inspection after the test completes.                                                                 |

**Note**: `STRESS_DROP_INDEXES` and `STRESS_UNSAFE_MODE` only affect the SQLite backend. They are ignored by `pg`, `kv`, and `fdb`.

**Note**: Stress tests are in a separate package and excluded from normal `pnpm test` runs. CI runs
the approximately 100,000-triple SQLite smoke profile without machine-specific latency assertions.

## Test Data

The stress test generates employee records with **10 attributes each**:

- `:name` - Employee name (string)
- `:email` - Email address (string)
- `:age` - Age 25-65 (number)
- `:salary` - Salary $50k-$225k, correlated with level (number)
- `:department` - 8 departments: Engineering, Sales, Marketing, HR, Finance, Operations, Legal, Support (string)
- `:title` - 6 levels: Junior, Mid-Level, Senior, Staff, Lead, Principal (string)
- `:active` - 90% true (boolean)
- `:hire_date` - Distributed over past days (datetime)
- `:location` - 5 locations: NYC, SF, Austin, Remote, London (string)
- `:manager` - 20% have manager references (ref)

**Total**: ~`EMPLOYEE_COUNT * 10` triples (default: ~1,000,000)

### Distribution Characteristics

- **More junior than senior**: Realistic organizational pyramid
- **Salary correlates with level**: Base + level premium + variation
- **Graph structure**: Manager references create queryable relationships (20% of employees)
- **Realistic distributions**: Age cycles 25-65, departments evenly distributed

## Triple-Pattern Tests (Q1-Q6)

These tests exercise `Triples.match` and `Triples.entity` directly:

| ID  | Test                 | Query Pattern                                               | Expected Results | Description                |
| --- | -------------------- | ----------------------------------------------------------- | ---------------- | -------------------------- |
| Q1  | Single entity lookup | `entity("emp:N")`                                           | 9-10 triples     | Point lookup by entity ID  |
| Q2  | Attribute scan       | `match({ attribute: ":salary" })`                           | All employees    | Full scan of one attribute |
| Q3  | Entity type filter   | `match({ entityType: "Employee" })`                         | All employees    | Filter by entity type      |
| Q4  | Specific value       | `match({ attribute: ":department", value: "Engineering" })` | 1/8 of employees | Composite attribute+value  |
| Q5  | Reference lookup     | `match({ attribute: ":manager", value: ref("emp:100") })`   | > 0              | Reference traversal        |
| Q6  | Boolean filter       | `match({ attribute: ":active", value: true })`              | 90% of employees | Boolean value filter       |

## Datalog Query Tests (D1-D6)

These tests exercise `Triples.query` with increasingly complex Datalog patterns:

| ID  | Test                | Datalog Pattern                                                                           | Expected Results | Description                  |
| --- | ------------------- | ----------------------------------------------------------------------------------------- | ---------------- | ---------------------------- |
| D1  | Simple pattern      | `find: [?name], where: [[?e, :name, ?name]]`                                              | All employees    | Single pattern clause        |
| D2  | Two-variable join   | `find: [?name, ?dept], where: [[?e, :name, ?name], [?e, :department, ?dept]]`             | All employees    | Self-join on entity variable |
| D3  | Predicate filter    | `find: [?name, ?salary], where: [..., [>=, ?salary, 150000]]`                             | Subset           | Numeric predicate            |
| D4  | Multi-attribute     | `find: [?name, ?title], where: [..., [?e, :department, "Engineering"]]`                   | 1/8 employees    | Value-bound pattern          |
| D5  | Aggregation         | `find: [?dept, (count ?e)], where: [[?e, :department, ?dept]]`                            | 8 rows           | Group by + count             |
| D6  | Reference traversal | `find: [?empName, ?mgrName], where: [..., [?e, :manager, ?mgr], [?mgr, :name, ?mgrName]]` | ~20% employees   | Ref join across entities     |

## Expected Performance

Performance thresholds are backend-specific to account for different storage characteristics:

### Triple-Pattern Queries

| Metric               | SQLite    | PostgreSQL |
| -------------------- | --------- | ---------- |
| Insertion throughput | > 1,000/s | > 500/s    |
| Q1: Entity lookup    | < 200ms   | < 200ms    |
| Q2: Attribute scan   | < 2,000ms | < 3,000ms  |
| Q3: Type filter      | < 2,000ms | < 3,000ms  |
| Q4: Value filter     | < 200ms   | < 300ms    |
| Q5: Ref lookup       | < 100ms   | < 200ms    |
| Q6: Boolean filter   | < 500ms   | < 1,000ms  |

### Datalog Queries

| Metric                | SQLite    | PostgreSQL |
| --------------------- | --------- | ---------- |
| D1: Simple pattern    | < 3,000ms | < 5,000ms  |
| D2: Two-variable join | < 5,000ms | < 8,000ms  |
| D3: Predicate filter  | < 5,000ms | < 8,000ms  |
| D4: Multi-attribute   | < 3,000ms | < 5,000ms  |
| D5: Aggregation       | < 5,000ms | < 8,000ms  |
| D6: Ref traversal     | < 5,000ms | < 8,000ms  |

## Implemented Optimizations (SQLite Only)

### 1. Multi-Row INSERT (DEFAULT)

`assertBatch` uses multi-row INSERT statements instead of sequential individual inserts.

### 2. Index Management (STRESS_DROP_INDEXES=true)

Drop 9 partial indexes before bulk insert, rebuild after. ~3-5x faster insertion.

### 3. PRAGMA Tuning (STRESS_UNSAFE_MODE=true)

```sql
PRAGMA synchronous = OFF;
PRAGMA journal_mode = MEMORY;
PRAGMA cache_size = -128000;
```

~1.2-2x faster. **WARNING**: Data may be lost if the process crashes during import.

## Database Inspection

### SQLite

```bash
# Keep database
STRESS_TEST_KEEP_DB=true pnpm --filter triplex-stress stress-test

# Inspect
sqlite3 stress-data/stress-test.db
.schema triples
SELECT COUNT(*) FROM triples;
EXPLAIN QUERY PLAN SELECT * FROM triples WHERE entity_id = 'emp:100';
```

### PostgreSQL

```bash
# Keep data
STRESS_BACKEND=pg DATABASE_URL=... STRESS_TEST_KEEP_DB=true \
  pnpm --filter triplex-stress stress-test

# Inspect via psql
psql $DATABASE_URL
SELECT COUNT(*) FROM triples;
```

## Architecture

```
                  STRESS_BACKEND env var
        +-------------+-------------+-------------+-------------+
        |             |             |             |             |
     "sqlite"        "pg"         "kv"          "fdb"
        |             |             |             |
+-------+------+ +----+--------+ +--+---------+ +--+---------+
|SqliteBackend | |PgBackend    | |InMemory KV | |FDB KV      |
|(StorageBackend)| |(StorageBackend)| |Hexastore | |Hexastore |
+-------+------+ +----+--------+ +--+---------+ +--+---------+
        |             |             |             |
        +------+------+             +------+------+
               |                           |
      DatabaseManager path          Direct KV path
        (sqlite / pg)                (kv / fdb)
               |                           |
          manager.getTriples             Triples
               \______________________/
                          |
                   stress queries
                      (Q1-Q6, D1-D6)
```

## Troubleshooting

### Test Times Out

Increase timeout in vitest.config.ts (currently 10 minutes):

```typescript
testTimeout: 1200000, // 20 minutes
```

### PostgreSQL Connection Refused

Ensure PostgreSQL is running and `DATABASE_URL` is correct:

```bash
# Test connectivity
psql $DATABASE_URL -c "SELECT 1"
```

### FoundationDB Connection Issues

For `STRESS_BACKEND=fdb`:

- Ensure FoundationDB client library (`libfdb_c`) is installed on the host.
- Ensure `FDB_CLUSTER_FILE` points to a reachable cluster endpoint.
- Set `STRESS_UPDATE_ROUNDS=0` (FDB/KV stress path has no SQL update helper).

### Slow Insertion

- **SQLite**: Try `STRESS_DROP_INDEXES=true STRESS_UNSAFE_MODE=true`
- **PostgreSQL**: Check connection latency, consider local PG instance
- **FoundationDB**: Run cluster locally / minimize network RTT for benchmarks

### No Console Output

This package uses `disableConsoleIntercept: true` in vitest.config.ts to show real-time progress.

## Contributing

When adding new stress tests:

1. Follow existing patterns in `test/triples-stress.test.ts`
2. Use realistic data from `src/data-generator.ts` or create new generators
3. Add backend-specific thresholds in `src/backend.ts`
4. Update performance tables in this README
5. Test the changed path against every available backend it supports; KV/SQLite are the baseline,
   while PostgreSQL and FoundationDB require their opt-in infrastructure

Stress results are performance diagnostics, not backend conformance. Consult
[`docs/current-state.md`](../../docs/current-state.md) before inferring support status from a
successful benchmark.
