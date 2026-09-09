# Performance

Triplex is pre-1.0 and does not yet publish a production performance guarantee. These measurements
are a reproducible baseline for finding scaling cliffs, not a capacity-planning substitute.

## September 2026 baseline

The following SQLite in-memory Datalog pagination measurements are medians of five warm runs on a
single 8-core, 16 GB Linux VM. Reads requested the first 100 rows unless explicitly described as
complete. There was no concurrent load.

|     Facts |                                    All facts, first 100 | Fixed attribute, first 100 | Join, first 100 | Group count |
| --------: | ------------------------------------------------------: | -------------------------: | --------------: | ----------: |
|    30,000 |                                                   35 ms |                      13 ms |           16 ms |       15 ms |
|   300,000 |                                                  346 ms |                     122 ms |          153 ms |      165 ms |
| 3,000,000 | Out of memory during an unbounded `queryAll` setup read |                          — |               — |           — |

The first-page latency grows with the number of candidate table rows even though the returned page
is fixed at 100. See [Datalog performance](datalog-performance.md) for the query-plan explanation and
indexing guidance. `queryAll` is intended only for trusted batch processing with an explicit memory
budget.

An in-memory KV run at approximately 920,000 triples measured about 3,400 inserted triples per
second and 823 ms for one entity lookup. Its entity-type scan exposed a stack overflow in large
cross-partition result collection; the implementation now appends entries iteratively and has a
150,000-entry regression test.

## Reproducing measurements

The multi-backend harness exercises writes through Triplex APIs, current and historical reads, and
Datalog queries:

```sh
# Quick SQLite smoke run (~100,000 initial triples)
pnpm --filter triplex-stress stress-test:smoke

# Full report; Docker enables PostgreSQL and a native client enables FoundationDB
pnpm --filter triplex-stress benchmark

# Focused pagination benchmark
pnpm --filter triplex-stress benchmark:datalog
```

The full report records Node, CPU, memory, fact count, update history depth, insertion throughput,
database size, and per-query wall time. PostgreSQL and FoundationDB results are omitted when their
required local infrastructure is unavailable. Always report storage mode, warm/cold cache state,
contention, and whether a read used bounded pagination or `queryAll` when comparing runs.
