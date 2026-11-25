/**
 * FederatedViews — DuckDB `UNION ALL` views over attached hot SQL + cold Parquet.
 *
 * Implements §5 (federated execution) and §6 (sensitive-value blind-token erasure
 * tombstones) of `docs/rfcs/cold-tier-duckdb.md`:
 * - Attaches hot SQLite (`TYPE SQLITE, READ_ONLY`) or PostgreSQL (`TYPE POSTGRES, READ_ONLY`),
 *   or binds to an existing DuckDB schema (e.g. mirrored in-memory hot tables).
 * - Unions hot tables with cold Parquet segments via `read_parquet([...], union_by_name = true)`
 *   for `triples`, `triplex_transactions`, and `triplex_transaction_entities`.
 * - Deduplicates any two-phase compaction overlap window cleanly by `id` / `tx_id` /
 *   `(entity_id, position)` with hot taking priority (`_tier = 0`).
 * - Preserves `value_sealed` and `value_blind` semantics and masks cold `value_blind`
 *   tokens for erased key IDs recorded in `triplex_cold_erased_keys`.
 * - Recreates `triplex_journal_attributes` and `triplex_journal_facts` over the federated
 *   journal views so Datalog `:_tx/*` and variable-attribute queries work unchanged.
 */

import * as path from "node:path";
import { Effect } from "effect";
import {
  JOURNAL_ATTRIBUTES,
  JOURNAL_FACTS_VIEW_DDL,
  ReadError,
  WriteError,
  type TripleRow,
} from "@triplex-internal/core/internal";
import type { SqlStatementRunner } from "@triplex-build/triplex-sql";
import { segmentPaths, type ColdManifest } from "../compaction/ColdManifest.js";

// =============================================================================
// Configuration Types
// =============================================================================

export type HotTierSource =
  | {
      readonly type: "sqlite";
      /** Path to the hot SQLite database file. */
      readonly path: string;
      /** DuckDB catalog alias for `ATTACH`. Defaults to `"hot_tier"`. */
      readonly alias?: string;
    }
  | {
      readonly type: "postgres";
      /** PostgreSQL connection string for `ATTACH`. */
      readonly connectionString: string;
      /** DuckDB catalog alias for `ATTACH`. Defaults to `"hot_tier"`. */
      readonly alias?: string;
      /** PostgreSQL schema name. Defaults to `"public"`. */
      readonly schema?: string;
    }
  | {
      readonly type: "schema";
      /** Existing DuckDB schema (or `catalog.schema`) containing the hot tables. */
      readonly schema: string;
    };

export interface ColdDatasetPaths {
  readonly triples: readonly string[];
  readonly transactions: readonly string[];
  readonly transactionEntities: readonly string[];
}

export interface FederatedViewsConfig {
  readonly hot: HotTierSource;
  /** Cold Parquet sources: either a `ColdManifest` or explicit dataset file path lists. */
  readonly cold: ColdManifest | ColdDatasetPaths;
  /** Optional base directory used to resolve relative Parquet paths from a manifest. */
  readonly baseDir?: string;
  /** Optional key IDs whose cold blind tokens must be masked to NULL (erasure tombstones). */
  readonly erasedKeyIds?: readonly string[];
}

// =============================================================================
// SQL Escaping & Table References
// =============================================================================

const quoteStringLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const quoteIdentifier = (identifier: string): string =>
  identifier
    .split(".")
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join(".");

const defaultHotAlias = (source: HotTierSource): string => {
  if (source.type === "schema") return source.schema;
  return source.alias ?? "hot_tier";
};

const hotTableRef = (source: HotTierSource, table: string): string => {
  if (source.type === "schema") {
    return `${quoteIdentifier(source.schema)}.${quoteIdentifier(table)}`;
  }
  const alias = quoteIdentifier(defaultHotAlias(source));
  if (source.type === "postgres") {
    const schema = quoteIdentifier(source.schema ?? "public");
    return `${alias}.${schema}.${quoteIdentifier(table)}`;
  }
  return `${alias}.${quoteIdentifier(table)}`;
};

const resolveParquetPath = (filePath: string, baseDir?: string): string => {
  if (
    baseDir === undefined ||
    path.isAbsolute(filePath) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(filePath)
  ) {
    return filePath;
  }
  return path.resolve(baseDir, filePath);
};

const parquetListSql = (paths: readonly string[], baseDir?: string): string =>
  `read_parquet([${paths.map((p) => quoteStringLiteral(resolveParquetPath(p, baseDir))).join(", ")}], union_by_name = true)`;

const isColdManifest = (cold: ColdManifest | ColdDatasetPaths): cold is ColdManifest =>
  "formatVersion" in cold && "segments" in cold;

/** Extract cold Parquet file paths from either a `ColdManifest` or explicit `ColdDatasetPaths`. */
export const extractColdDatasetPaths = (
  cold: ColdManifest | ColdDatasetPaths,
): ColdDatasetPaths => {
  if (isColdManifest(cold)) {
    return {
      triples: segmentPaths(cold, "triples"),
      transactions: segmentPaths(cold, "transactions"),
      transactionEntities: segmentPaths(cold, "transaction_entities"),
    };
  }
  return cold;
};

// =============================================================================
// Column Projections & DDL Builders
// =============================================================================

export const COLD_ERASED_KEYS_TABLE = "triplex_cold_erased_keys";
const JOURNAL_ATTRIBUTES_TABLE = "triplex_journal_attributes";

export const COLD_ERASED_KEYS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS ${COLD_ERASED_KEYS_TABLE} (
    key_id VARCHAR PRIMARY KEY,
    key_id_json VARCHAR NOT NULL
  )
`;

const TRIPLES_COLUMN_NAMES = [
  "id",
  "entity_id",
  "attribute",
  "value_type",
  "value_string",
  "value_number",
  "value_boolean",
  "value_datetime",
  "value_json",
  "recorded_at",
  "recorded_position",
  "valid_from",
  "valid_to",
  "created_by",
  "retracted_at",
  "retracted_position",
  "retract_tx_id",
  "entity_type",
  "schema_version",
  "tx_id",
  "value_sealed",
  "value_blind",
] as const;

const triplesHotProjection = (): string =>
  [
    "CAST(id AS VARCHAR) AS id",
    "CAST(entity_id AS VARCHAR) AS entity_id",
    "CAST(attribute AS VARCHAR) AS attribute",
    "CAST(value_type AS VARCHAR) AS value_type",
    "CAST(value_string AS VARCHAR) AS value_string",
    "CAST(value_number AS DOUBLE) AS value_number",
    "CAST(value_boolean AS INTEGER) AS value_boolean",
    "CAST(value_datetime AS BIGINT) AS value_datetime",
    "CAST(value_json AS VARCHAR) AS value_json",
    "CAST(recorded_at AS BIGINT) AS recorded_at",
    "CAST(recorded_position AS BIGINT) AS recorded_position",
    "CAST(valid_from AS BIGINT) AS valid_from",
    "CAST(valid_to AS BIGINT) AS valid_to",
    "CAST(created_by AS VARCHAR) AS created_by",
    "CAST(retracted_at AS BIGINT) AS retracted_at",
    "CAST(retracted_position AS BIGINT) AS retracted_position",
    "CAST(retract_tx_id AS VARCHAR) AS retract_tx_id",
    "CAST(entity_type AS VARCHAR) AS entity_type",
    "CAST(schema_version AS INTEGER) AS schema_version",
    "CAST(tx_id AS VARCHAR) AS tx_id",
    "CAST(value_sealed AS VARCHAR) AS value_sealed",
    "CAST(value_blind AS VARCHAR) AS value_blind",
  ].join(", ");

const triplesColdProjection = (): string =>
  [
    "CAST(id AS VARCHAR) AS id",
    "CAST(entity_id AS VARCHAR) AS entity_id",
    "CAST(attribute AS VARCHAR) AS attribute",
    "CAST(value_type AS VARCHAR) AS value_type",
    "CAST(value_string AS VARCHAR) AS value_string",
    "CAST(value_number AS DOUBLE) AS value_number",
    "CAST(value_boolean AS INTEGER) AS value_boolean",
    "CAST(value_datetime AS BIGINT) AS value_datetime",
    "CAST(value_json AS VARCHAR) AS value_json",
    "CAST(recorded_at AS BIGINT) AS recorded_at",
    "CAST(recorded_position AS BIGINT) AS recorded_position",
    "CAST(valid_from AS BIGINT) AS valid_from",
    "CAST(valid_to AS BIGINT) AS valid_to",
    "CAST(created_by AS VARCHAR) AS created_by",
    "CAST(retracted_at AS BIGINT) AS retracted_at",
    "CAST(retracted_position AS BIGINT) AS retracted_position",
    "CAST(retract_tx_id AS VARCHAR) AS retract_tx_id",
    "CAST(entity_type AS VARCHAR) AS entity_type",
    "CAST(schema_version AS INTEGER) AS schema_version",
    "CAST(tx_id AS VARCHAR) AS tx_id",
    "CAST(value_sealed AS VARCHAR) AS value_sealed",
    `CASE
      WHEN value_type = 'sealed' AND value_blind IS NOT NULL AND EXISTS (
        SELECT 1 FROM ${COLD_ERASED_KEYS_TABLE} ek
        WHERE strpos(CAST(value_sealed AS VARCHAR), '"keyId":' || ek.key_id_json || ',"ciphertext"') > 0
      )
      THEN CAST(NULL AS VARCHAR)
      ELSE CAST(value_blind AS VARCHAR)
    END AS value_blind`,
  ].join(", ");

const TRANSACTIONS_COLUMN_NAMES = [
  "tx_id",
  "position",
  "instant",
  "actor",
  "command_id",
  "correlation_id",
  "causation_id",
  "config_snapshot",
  "changes",
] as const;

const transactionsProjection = (): string =>
  [
    "CAST(tx_id AS VARCHAR) AS tx_id",
    "CAST(position AS BIGINT) AS position",
    "CAST(instant AS BIGINT) AS instant",
    "CAST(actor AS VARCHAR) AS actor",
    "CAST(command_id AS VARCHAR) AS command_id",
    "CAST(correlation_id AS VARCHAR) AS correlation_id",
    "CAST(causation_id AS VARCHAR) AS causation_id",
    "CAST(config_snapshot AS VARCHAR) AS config_snapshot",
    "CAST(changes AS VARCHAR) AS changes",
  ].join(", ");

const TRANSACTION_ENTITIES_COLUMN_NAMES = ["entity_id", "position", "tx_id"] as const;

const transactionEntitiesProjection = (): string =>
  [
    "CAST(entity_id AS VARCHAR) AS entity_id",
    "CAST(position AS BIGINT) AS position",
    "CAST(tx_id AS VARCHAR) AS tx_id",
  ].join(", ");

/** Build the DuckDB `ATTACH` statement for a SQLite or PostgreSQL hot source, if applicable. */
export const buildAttachHotSql = (source: HotTierSource): string | undefined => {
  if (source.type === "schema") return undefined;
  const alias = quoteIdentifier(defaultHotAlias(source));
  if (source.type === "sqlite") {
    return `ATTACH IF NOT EXISTS ${quoteStringLiteral(source.path)} AS ${alias} (TYPE SQLITE, READ_ONLY)`;
  }
  return `ATTACH IF NOT EXISTS ${quoteStringLiteral(source.connectionString)} AS ${alias} (TYPE POSTGRES, READ_ONLY)`;
};

/** Build the federated `triples` view DDL, deduplicating any hot/cold overlap by `id`. */
export const buildFederatedTriplesViewSql = (
  hot: HotTierSource,
  coldPaths: readonly string[],
  baseDir?: string,
): string => {
  const hotTable = hotTableRef(hot, "triples");
  if (coldPaths.length === 0) {
    return `CREATE OR REPLACE VIEW triples AS SELECT ${triplesHotProjection()} FROM ${hotTable}`;
  }
  const cols = TRIPLES_COLUMN_NAMES.join(", ");
  return `CREATE OR REPLACE VIEW triples AS
SELECT ${cols}
FROM (
  SELECT 0 AS _tier, ${triplesHotProjection()} FROM ${hotTable}
  UNION ALL
  SELECT 1 AS _tier, ${triplesColdProjection()} FROM ${parquetListSql(coldPaths, baseDir)}
)
QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY _tier ASC) = 1`;
};

/** Build the federated `triplex_transactions` view DDL, deduplicating overlap by `tx_id`. */
export const buildFederatedTransactionsViewSql = (
  hot: HotTierSource,
  coldPaths: readonly string[],
  baseDir?: string,
): string => {
  const hotTable = hotTableRef(hot, "triplex_transactions");
  if (coldPaths.length === 0) {
    return `CREATE OR REPLACE VIEW triplex_transactions AS SELECT ${transactionsProjection()} FROM ${hotTable}`;
  }
  const cols = TRANSACTIONS_COLUMN_NAMES.join(", ");
  return `CREATE OR REPLACE VIEW triplex_transactions AS
SELECT ${cols}
FROM (
  SELECT 0 AS _tier, ${transactionsProjection()} FROM ${hotTable}
  UNION ALL
  SELECT 1 AS _tier, ${transactionsProjection()} FROM ${parquetListSql(coldPaths, baseDir)}
)
QUALIFY ROW_NUMBER() OVER (PARTITION BY tx_id ORDER BY _tier ASC) = 1`;
};

/** Build the federated `triplex_transaction_entities` view DDL, deduplicating by `(entity_id, position)`. */
export const buildFederatedTransactionEntitiesViewSql = (
  hot: HotTierSource,
  coldPaths: readonly string[],
  baseDir?: string,
): string => {
  const hotTable = hotTableRef(hot, "triplex_transaction_entities");
  if (coldPaths.length === 0) {
    return `CREATE OR REPLACE VIEW triplex_transaction_entities AS SELECT ${transactionEntitiesProjection()} FROM ${hotTable}`;
  }
  const cols = TRANSACTION_ENTITIES_COLUMN_NAMES.join(", ");
  return `CREATE OR REPLACE VIEW triplex_transaction_entities AS
SELECT ${cols}
FROM (
  SELECT 0 AS _tier, ${transactionEntitiesProjection()} FROM ${hotTable}
  UNION ALL
  SELECT 1 AS _tier, ${transactionEntitiesProjection()} FROM ${parquetListSql(coldPaths, baseDir)}
)
QUALIFY ROW_NUMBER() OVER (PARTITION BY entity_id, position ORDER BY _tier ASC) = 1`;
};

const FEDERATED_JOURNAL_FACTS_VIEW_DDL = JOURNAL_FACTS_VIEW_DDL.replace(
  /^CREATE VIEW /i,
  "CREATE OR REPLACE VIEW ",
);

/** Build the complete ordered list of DuckDB DDL statements to configure federated views. */
export const buildFederatedViewsDdl = (config: FederatedViewsConfig): readonly string[] => {
  const cold = extractColdDatasetPaths(config.cold);
  const statements: string[] = [COLD_ERASED_KEYS_TABLE_DDL];

  const attach = buildAttachHotSql(config.hot);
  if (attach !== undefined) {
    statements.push(attach);
  }

  statements.push(buildFederatedTriplesViewSql(config.hot, cold.triples, config.baseDir));
  statements.push(buildFederatedTransactionsViewSql(config.hot, cold.transactions, config.baseDir));
  statements.push(
    buildFederatedTransactionEntitiesViewSql(config.hot, cold.transactionEntities, config.baseDir),
  );

  statements.push(
    `CREATE TABLE IF NOT EXISTS ${JOURNAL_ATTRIBUTES_TABLE} (attribute VARCHAR PRIMARY KEY NOT NULL)`,
  );
  for (const attr of JOURNAL_ATTRIBUTES) {
    statements.push(
      `INSERT INTO ${JOURNAL_ATTRIBUTES_TABLE} (attribute) VALUES (${quoteStringLiteral(attr)}) ON CONFLICT DO NOTHING`,
    );
  }
  statements.push(FEDERATED_JOURNAL_FACTS_VIEW_DDL);

  return statements;
};

// =============================================================================
// Runtime Setup & Erasure Tombstones
// =============================================================================

/** Record erased key IDs in DuckDB so cold `value_blind` tokens are immediately masked to NULL. */
export const recordColdErasedKeys = (
  runner: SqlStatementRunner,
  keyIds: readonly string[],
): Effect.Effect<void, WriteError> =>
  Effect.gen(function* () {
    if (keyIds.length === 0) return;
    yield* runner.run(COLD_ERASED_KEYS_TABLE_DDL, []);
    for (const keyId of keyIds) {
      yield* runner.run(
        `INSERT INTO ${COLD_ERASED_KEYS_TABLE} (key_id, key_id_json) VALUES (${quoteStringLiteral(keyId)}, ${quoteStringLiteral(JSON.stringify(keyId))}) ON CONFLICT DO NOTHING`,
        [],
      );
    }
  }).pipe(
    Effect.mapError(
      (cause) =>
        new WriteError({
          message: `Failed to record cold erasure tombstones: ${String(cause)}`,
          cause,
        }),
    ),
  );

/**
 * Create or refresh the DuckDB federated views over hot SQL + cold Parquet segments.
 * Safe to call repeatedly whenever the cold manifest advances.
 */
export const setupFederatedViews = (
  runner: SqlStatementRunner,
  config: FederatedViewsConfig,
): Effect.Effect<void, ReadError> =>
  Effect.gen(function* () {
    const statements = buildFederatedViewsDdl(config);
    for (const sql of statements) {
      yield* runner.run(sql, []);
    }
    if (config.erasedKeyIds && config.erasedKeyIds.length > 0) {
      for (const keyId of config.erasedKeyIds) {
        yield* runner.run(
          `INSERT INTO ${COLD_ERASED_KEYS_TABLE} (key_id, key_id_json) VALUES (${quoteStringLiteral(keyId)}, ${quoteStringLiteral(JSON.stringify(keyId))}) ON CONFLICT DO NOTHING`,
          [],
        );
      }
    }
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ReadError({
          message: `Failed to set up DuckDB federated views: ${String(cause)}`,
          cause,
        }),
    ),
  );

// =============================================================================
// Hot-to-DuckDB Schema Sync (for in-memory SQLite or extensionless environments)
// =============================================================================

interface HotTransactionRow extends Record<string, unknown> {
  readonly tx_id: string;
  readonly position: number | string | bigint;
  readonly instant: number | string | bigint;
  readonly actor: string | null;
  readonly command_id: string | null;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly config_snapshot: string | null;
  readonly changes: string;
}

interface HotTransactionEntityRow extends Record<string, unknown> {
  readonly entity_id: string;
  readonly position: number | string | bigint;
  readonly tx_id: string;
}

const sqlLiteral = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  return quoteStringLiteral(String(value));
};

/**
 * Mirror hot `triples`, `triplex_transactions`, and `triplex_transaction_entities`
 * into a DuckDB schema (`hot_tier` by default).
 *
 * Useful when the hot database is in-memory SQLite (`:memory:`) or when DuckDB's
 * `sqlite_scanner` / `postgres_scanner` extension is unavailable.
 */
export const syncHotTablesToDuckDb = (
  hotRunner: SqlStatementRunner,
  duckDbRunner: SqlStatementRunner,
  schema = "hot_tier",
): Effect.Effect<void, ReadError> =>
  Effect.gen(function* () {
    const qSchema = quoteIdentifier(schema);
    yield* duckDbRunner.run(`CREATE SCHEMA IF NOT EXISTS ${qSchema}`, []);

    yield* duckDbRunner.run(
      `CREATE OR REPLACE TABLE ${qSchema}.triples (
        id VARCHAR PRIMARY KEY,
        entity_id VARCHAR NOT NULL,
        attribute VARCHAR NOT NULL,
        value_type VARCHAR NOT NULL,
        value_string VARCHAR,
        value_number DOUBLE,
        value_boolean INTEGER,
        value_datetime BIGINT,
        value_json VARCHAR,
        recorded_at BIGINT NOT NULL,
        recorded_position BIGINT NOT NULL,
        valid_from BIGINT NOT NULL,
        valid_to BIGINT,
        created_by VARCHAR,
        retracted_at BIGINT,
        retracted_position BIGINT,
        retract_tx_id VARCHAR,
        entity_type VARCHAR,
        schema_version INTEGER,
        tx_id VARCHAR,
        value_sealed VARCHAR,
        value_blind VARCHAR
      )`,
      [],
    );

    yield* duckDbRunner.run(
      `CREATE OR REPLACE TABLE ${qSchema}.triplex_transactions (
        tx_id VARCHAR PRIMARY KEY,
        position BIGINT NOT NULL,
        instant BIGINT NOT NULL,
        actor VARCHAR,
        command_id VARCHAR,
        correlation_id VARCHAR,
        causation_id VARCHAR,
        config_snapshot VARCHAR,
        changes VARCHAR NOT NULL
      )`,
      [],
    );

    yield* duckDbRunner.run(
      `CREATE OR REPLACE TABLE ${qSchema}.triplex_transaction_entities (
        entity_id VARCHAR NOT NULL,
        position BIGINT NOT NULL,
        tx_id VARCHAR NOT NULL,
        PRIMARY KEY (entity_id, position)
      )`,
      [],
    );

    const triples = yield* hotRunner.run<TripleRow & Record<string, unknown>>(
      `SELECT ${TRIPLES_COLUMN_NAMES.join(", ")} FROM triples`,
      [],
    );
    for (let i = 0; i < triples.length; i += 200) {
      const chunk = triples.slice(i, i + 200);
      const values = chunk
        .map(
          (row) =>
            `(${TRIPLES_COLUMN_NAMES.map((col) => sqlLiteral((row as Record<string, unknown>)[col])).join(", ")})`,
        )
        .join(", ");
      yield* duckDbRunner.run(
        `INSERT INTO ${qSchema}.triples (${TRIPLES_COLUMN_NAMES.join(", ")}) VALUES ${values}`,
        [],
      );
    }

    const txs = yield* hotRunner.run<HotTransactionRow>(
      `SELECT ${TRANSACTIONS_COLUMN_NAMES.join(", ")} FROM triplex_transactions`,
      [],
    );
    for (let i = 0; i < txs.length; i += 200) {
      const chunk = txs.slice(i, i + 200);
      const values = chunk
        .map(
          (row) => `(${TRANSACTIONS_COLUMN_NAMES.map((col) => sqlLiteral(row[col])).join(", ")})`,
        )
        .join(", ");
      yield* duckDbRunner.run(
        `INSERT INTO ${qSchema}.triplex_transactions (${TRANSACTIONS_COLUMN_NAMES.join(", ")}) VALUES ${values}`,
        [],
      );
    }

    const txEntities = yield* hotRunner.run<HotTransactionEntityRow>(
      `SELECT ${TRANSACTION_ENTITIES_COLUMN_NAMES.join(", ")} FROM triplex_transaction_entities`,
      [],
    );
    for (let i = 0; i < txEntities.length; i += 200) {
      const chunk = txEntities.slice(i, i + 200);
      const values = chunk
        .map(
          (row) =>
            `(${TRANSACTION_ENTITIES_COLUMN_NAMES.map((col) => sqlLiteral(row[col])).join(", ")})`,
        )
        .join(", ");
      yield* duckDbRunner.run(
        `INSERT INTO ${qSchema}.triplex_transaction_entities (${TRANSACTION_ENTITIES_COLUMN_NAMES.join(", ")}) VALUES ${values}`,
        [],
      );
    }
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ReadError({
          message: `Failed to sync hot tables to DuckDB schema "${schema}": ${String(cause)}`,
          cause,
        }),
    ),
  );
