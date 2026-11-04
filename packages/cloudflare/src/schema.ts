import { NUMERIC_VALUE_INDEX_DDL, SEALED_BLIND_INDEX_DDL } from "@triplex-build/triplex-sql";

/**
 * Cloudflare database schema support.
 *
 * Localizes the schema DDL needed by the Durable Object adapter so the
 * Cloudflare database package owns this support surface directly.
 */

export const TRIPLES_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS triples (
    id TEXT PRIMARY KEY NOT NULL,
    entity_id TEXT NOT NULL,
    attribute TEXT NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN ('string', 'number', 'boolean', 'datetime', 'ref', 'json', 'blob')),
    value_string TEXT,
    value_number REAL,
    value_boolean INTEGER,
    value_datetime BIGINT,
    value_json TEXT,
    recorded_at BIGINT NOT NULL,
    recorded_position BIGINT NOT NULL,
    valid_from BIGINT NOT NULL,
    valid_to BIGINT,
    created_by TEXT,
    retracted_at BIGINT,
    retracted_position BIGINT,
    retract_tx_id TEXT,
    entity_type TEXT,
    schema_version INTEGER DEFAULT 1,
    tx_id TEXT
  )
`;

export const MIGRATIONS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS triplex_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at BIGINT NOT NULL
  )
`;

export const COMMIT_POSITION_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS triplex_commit_position (
    singleton INTEGER PRIMARY KEY,
    position BIGINT NOT NULL
  )
`;

export const COMMAND_RECEIPTS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS triplex_command_receipts (
    command_id TEXT PRIMARY KEY NOT NULL,
    transaction_id TEXT NOT NULL UNIQUE,
    recorded_at BIGINT NOT NULL
  )
`;

export const BASELINE_INDEX_DDLS = [
  "CREATE INDEX IF NOT EXISTS idx_entity ON triples(entity_id) WHERE retracted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_attribute ON triples(attribute) WHERE retracted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_attribute_history ON triples(attribute, recorded_position, retracted_position)",
  "CREATE INDEX IF NOT EXISTS idx_attribute_temporal ON triples(attribute, valid_from, valid_to) WHERE retracted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_type ON triples(entity_type) WHERE retracted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_attr_string ON triples(attribute, value_string) WHERE retracted_at IS NULL AND value_type = 'string'",
  "CREATE INDEX IF NOT EXISTS idx_attr_number ON triples(attribute, value_number) WHERE retracted_at IS NULL AND value_type = 'number'",
  "CREATE INDEX IF NOT EXISTS idx_ref_target ON triples(value_string) WHERE retracted_at IS NULL AND value_type = 'ref'",
  "CREATE INDEX IF NOT EXISTS idx_temporal ON triples(entity_id, recorded_at, retracted_at, valid_from, valid_to)",
  "CREATE INDEX IF NOT EXISTS idx_recorded_position ON triples(recorded_position, retracted_position)",
  "CREATE INDEX IF NOT EXISTS idx_entity_attr ON triples(entity_id, attribute) WHERE retracted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_tx_id ON triples(tx_id) WHERE retracted_at IS NULL",
] as const;

export const INDEX_DDLS = [
  ...BASELINE_INDEX_DDLS,
  NUMERIC_VALUE_INDEX_DDL,
  SEALED_BLIND_INDEX_DDL,
] as const;

const TRIPLES_V3_COLUMNS =
  "id, entity_id, attribute, value_type, value_string, value_number, value_boolean, value_datetime, value_json, recorded_at, recorded_position, valid_from, valid_to, created_by, retracted_at, retracted_position, retract_tx_id, entity_type, schema_version, tx_id";

/**
 * Migration v4 rebuilds `triples` so `sealed` is an admitted value type and
 * sealed values keep their envelope and blind-index token in dedicated
 * columns. Durable Object SQLite cannot alter a CHECK constraint, so this uses
 * SQLite's create-copy-drop-rename procedure inside the initialize transaction.
 */
export const SEALED_VALUES_DDLS = [
  "DROP TABLE IF EXISTS triples_v4",
  TRIPLES_TABLE_DDL.replace("CREATE TABLE IF NOT EXISTS triples (", "CREATE TABLE triples_v4 (")
    .replace("'json', 'blob')", "'json', 'blob', 'sealed')")
    .replace(
      "tx_id TEXT\n  )",
      "tx_id TEXT,\n    value_sealed TEXT,\n    value_blind TEXT,\n    CHECK (value_type <> 'sealed' OR value_sealed IS NOT NULL)\n  )",
    ),
  `INSERT INTO triples_v4 (${TRIPLES_V3_COLUMNS}) SELECT ${TRIPLES_V3_COLUMNS} FROM triples`,
  "DROP TABLE triples",
  "ALTER TABLE triples_v4 RENAME TO triples",
  ...BASELINE_INDEX_DDLS,
  NUMERIC_VALUE_INDEX_DDL,
  SEALED_BLIND_INDEX_DDL,
] as const;

export const INDEX_NAMES = [
  "idx_entity",
  "idx_attribute",
  "idx_attribute_history",
  "idx_attribute_temporal",
  "idx_type",
  "idx_attr_blind",
  "idx_attr_string",
  "idx_attr_number",
  "idx_attr_numeric",
  "idx_ref_target",
  "idx_temporal",
  "idx_recorded_position",
  "idx_entity_attr",
  "idx_tx_id",
] as const;
