import { isAbsolute } from "node:path";
import { Context, Effect, Layer, Semaphore, type Scope } from "effect";
import { ReadError, type DatalogQueryError, type WrappedQuery } from "@bjacobso/triplex";
import type { QueryExecutorService } from "@bjacobso/triplex/internal";
import { makeSqlQueryExecutor } from "@bjacobso/triplex-sql";
import { DuckdbDialect } from "./dialect.js";
import { makeTable } from "./federation/table.js";
import { makeSource, type SourceWorker } from "./federation/source.js";
import { makeProcessSource } from "./federation/worker-client.js";
import { planFederation, type FederationPlan } from "./federation/planner.js";
import {
  SnapshotProvider,
  DATABASE_ATTRIBUTE,
  TENANT_ATTRIBUTE,
  TX_DATABASE_ATTRIBUTE,
  databaseEntity,
  sourceEntity,
  federationFailure,
  type FactRow,
  type FederatedQuery,
} from "./federation/types.js";

export interface DuckdbFederationOptions {
  /** Separate local processes by default; in-process is useful as a reference. */
  readonly mode?: "workers" | "in-process";
  readonly batchSize?: number;
  readonly threads?: number;
  readonly workerTimeoutMs?: number;
}
export interface FederationSourceMetadata {
  readonly database: string;
  readonly tenant: string;
  readonly pid: number;
  readonly snapshot: SourceWorker["metadata"];
}
export interface FederationExecution {
  readonly mode: "workers" | "in-process";
  readonly sources: readonly FederationSourceMetadata[];
  /** Includes requested virtual membership facts; excludes coordinator catalog facts. */
  readonly rowsTransferred: number;
  readonly fragments: readonly {
    readonly database: string;
    readonly attributes: readonly string[] | null;
    readonly rows: number;
  }[];
  readonly coordinator: "duckdb";
}
type AllResult = Effect.Success<ReturnType<QueryExecutorService["execute"]>>;
type WindowResult = Effect.Success<ReturnType<QueryExecutorService["executePage"]>>;
export type FederatedWrappedQuery = Omit<WrappedQuery, "inner"> & {
  readonly inner: FederatedQuery;
};
export interface DuckdbFederationService {
  readonly sources: readonly FederationSourceMetadata[];
  readonly explain: (query: FederatedQuery) => Effect.Effect<FederationPlan, ReadError>;
  readonly queryAll: (
    query: FederatedQuery,
    debug?: boolean,
  ) => Effect.Effect<
    AllResult & { readonly federation: FederationExecution },
    ReadError | DatalogQueryError
  >;
  readonly queryWindow: (
    query: FederatedWrappedQuery,
    debug?: boolean,
  ) => Effect.Effect<
    WindowResult & { readonly federation: FederationExecution },
    ReadError | DatalogQueryError
  >;
}

const qualify = (database: string, row: FactRow): FactRow => ({
  ...row,
  id: sourceEntity(database, String(row["id"])),
  entity_id: sourceEntity(database, String(row["entity_id"])),
  value_string:
    row["value_type"] === "ref" &&
    row["attribute"] !== DATABASE_ATTRIBUTE &&
    row["attribute"] !== TX_DATABASE_ATTRIBUTE
      ? sourceEntity(database, String(row["value_string"]))
      : row["value_string"],
  tx_id: row["tx_id"] == null ? null : sourceEntity(database, String(row["tx_id"])),
  created_by: row["created_by"] == null ? null : sourceEntity(database, String(row["created_by"])),
  // Source visibility is already resolved; a single global temporal cut would be incorrect.
  retracted_at: null,
  retracted_position: null,
  retract_tx_id: null,
});

export const makeDuckdbFederation = (
  options: DuckdbFederationOptions = {},
): Effect.Effect<DuckdbFederationService, ReadError, SnapshotProvider | Scope.Scope> =>
  Effect.gen(function* () {
    const provider = yield* SnapshotProvider;
    const catalog = yield* provider.databases;
    const mode = options.mode ?? "workers";
    const batchSize = options.batchSize ?? 2048;
    const threads = options.threads ?? 4;
    const timeoutMs = options.workerTimeoutMs ?? 30_000;
    if (
      !["workers", "in-process"].includes(mode) ||
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > 65_536 ||
      !Number.isSafeInteger(threads) ||
      threads < 1 ||
      threads > 64 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 2_147_483_647
    )
      return yield* Effect.fail(
        federationFailure(
          "Invalid federation mode, batchSize (1..65536), threads (1..64), or positive workerTimeoutMs",
        ),
      );
    if (
      catalog.length === 0 ||
      catalog.length > 32 ||
      new Set(catalog.map((db) => db.id)).size !== catalog.length ||
      catalog.some((db) => !db.id.trim() || !db.tenant.trim() || !isAbsolute(db.filename))
    )
      return yield* Effect.fail(
        federationFailure(
          "Expected 1..32 unique database IDs, nonempty tenants, and absolute SQLite filenames",
        ),
      );
    const workers = new Map<string, SourceWorker>();
    for (const database of catalog) {
      const worker = yield* mode === "workers"
        ? makeProcessSource(database, batchSize, timeoutMs)
        : makeSource(database, batchSize);
      workers.set(database.id, worker);
    }
    const sources = Object.freeze(
      catalog.map((db): FederationSourceMetadata => {
        const worker = workers.get(db.id)!;
        return Object.freeze({
          database: db.id,
          tenant: db.tenant,
          pid: worker.pid,
          snapshot: Object.freeze({
            ...worker.metadata,
            basis: Object.freeze({ ...worker.metadata.basis }),
          }),
        });
      }),
    );
    const semaphore = yield* Semaphore.make(1);
    const explain = (query: FederatedQuery) =>
      Effect.try({ try: () => planFederation(query, catalog), catch: federationFailure });
    const execute = <A>(
      query: FederatedQuery,
      run: (
        executor: QueryExecutorService,
        plan: FederationPlan,
      ) => Effect.Effect<A, ReadError | DatalogQueryError>,
    ) =>
      semaphore.withPermits(1)(
        Effect.scoped(
          Effect.gen(function* () {
            const plan = yield* explain(query);
            const table = yield* makeTable(threads);
            const fragments: {
              database: string;
              attributes: readonly string[] | null;
              rows: number;
            }[] = [];
            for (const id of plan.databases) {
              const worker = workers.get(id)!;
              let after: string | null = null;
              let count = 0;
              while (true) {
                const rows: readonly FactRow[] = yield* worker.scan({
                  attributes: plan.attributes,
                  after,
                  limit: batchSize,
                });
                if (rows.length === 0) break;
                yield* table.append(rows.map((row) => qualify(id, row)));
                count += rows.length;
                after = String(rows[rows.length - 1]!["id"]);
                if (rows.length < batchSize) break;
              }
              fragments.push({ database: id, attributes: plan.attributes, rows: count });
            }
            // Catalog facts are available even for an empty database.
            yield* table.append(
              catalog.map((db) => ({
                id: databaseEntity(db.id),
                entity_id: databaseEntity(db.id),
                attribute: TENANT_ATTRIBUTE,
                value_type: "string",
                value_string: db.tenant,
                recorded_at: 0,
                recorded_position: 0,
                valid_from: 0,
                schema_version: 1,
              })),
            );
            yield* table.runner.run("ANALYZE triples", []).pipe(Effect.mapError(federationFailure));
            const result = yield* run(makeSqlQueryExecutor(table.runner, DuckdbDialect), plan);
            const federation: FederationExecution = {
              mode,
              sources: sources.filter((source) => plan.databases.includes(source.database)),
              rowsTransferred: fragments.reduce((sum, fragment) => sum + fragment.rows, 0),
              fragments,
              coordinator: "duckdb",
            };
            return { ...result, federation };
          }),
        ),
      );
    return {
      sources,
      explain,
      queryAll: (query, debug = false) =>
        execute(query, (executor, plan) => executor.execute(plan.query, debug)),
      queryWindow: (query, debug = false) =>
        execute(query.inner, (executor, plan) =>
          executor.executePage({ ...query, inner: plan.query }, debug),
        ),
    };
  });

export class DuckdbFederation extends Context.Service<DuckdbFederation, DuckdbFederationService>()(
  "triplex/DuckdbFederation",
) {
  static layer(options: DuckdbFederationOptions = {}) {
    return Layer.effect(DuckdbFederation, makeDuckdbFederation(options));
  }
}
