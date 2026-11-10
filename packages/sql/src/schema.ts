/**
 * Centralized Schema Definitions
 *
 * This is the single source of truth for all database DDL.
 * Both Node.js (migrations.ts) and Cloudflare (CloudflareAdapter.ts) import from here.
 *
 * Why centralize:
 * - Prevents schema drift between platforms
 * - Single place to update when adding columns/indexes
 * - Enables sharing between different adapters
 */

// =============================================================================
// Table Definitions
// =============================================================================

/**
 * Triples table DDL
 *
 * Core table storing all facts as entity-attribute-value triples.
 * Supports:
 * - Multiple value types (string, number, boolean, datetime, ref, json)
 * - Recorded-time history via recorded_at/retracted_at timestamps
 * - Business-time history via valid_from/valid_to timestamps
 * - Entity typing for schema validation
 * - Transaction grouping via tx_id
 */
export const TRIPLES_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS triples (
    id TEXT PRIMARY KEY NOT NULL,
    entity_id TEXT NOT NULL,
    attribute TEXT NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN ('string', 'number', 'boolean', 'datetime', 'ref', 'json', 'blob')),
    value_string TEXT,
    value_number DOUBLE PRECISION,
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

/**
 * Schema migrations table DDL
 *
 * Tracks applied migrations for versioned schema updates.
 */
export const MIGRATIONS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS triplex_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at BIGINT NOT NULL
  )
`;

/**
 * Single-row counter used to assign a total order to committed transactions.
 * The increment occurs inside the same backend transaction as the fact writes.
 */
export const COMMIT_POSITION_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS triplex_commit_position (
    singleton INTEGER PRIMARY KEY,
    position BIGINT NOT NULL
  )
`;

/**
 * Atomic uniqueness index for command receipts.
 *
 * The corresponding `_Transaction` facts remain the public, queryable
 * receipt. This table exists only to make first-writer-wins atomic across
 * pooled SQL connections.
 */
export const COMMAND_RECEIPTS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS triplex_command_receipts (
    command_id TEXT PRIMARY KEY NOT NULL,
    transaction_id TEXT NOT NULL UNIQUE,
    recorded_at BIGINT NOT NULL
  )
`;

// =============================================================================
// Index Definitions
// =============================================================================

/**
 * Frozen v1 index definitions for the triples table.
 *
 * These indexes optimize common query patterns:
 * - Entity lookups (idx_entity)
 * - Attribute scans (idx_attribute)
 * - Type filtering (idx_type)
 * - Value searches (idx_attr_string, idx_attr_number)
 * - Reference traversal (idx_ref_target)
 * - Time travel queries (idx_temporal)
 * - Entity+attribute lookups (idx_entity_attr)
 * - Transaction queries (idx_tx_id)
 */
export const BASELINE_INDEX_DDLS = [
  "CREATE INDEX IF NOT EXISTS idx_entity ON triples(entity_id) WHERE retracted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_attribute ON triples(attribute) WHERE retracted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_attribute_history ON triples(attribute, recorded_position, retracted_position)",
  "CREATE INDEX IF NOT EXISTS idx_attribute_temporal ON triples(attribute, valid_from, valid_to) WHERE retracted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_type ON triples(entity_type) WHERE retracted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_attr_string ON triples(attribute, value_string) WHERE retracted_at IS NULL AND value_type = 'string'",
  "CREATE INDEX IF NOT EXISTS idx_attr_number ON triples(attribute, value_number) WHERE retracted_at IS NULL AND value_type = 'number'",
  "CREATE INDEX IF NOT EXISTS idx_ref_target ON triples(attribute, value_string, entity_id) WHERE retracted_at IS NULL AND value_type = 'ref'",
  "CREATE INDEX IF NOT EXISTS idx_temporal ON triples(entity_id, recorded_at, retracted_at, valid_from, valid_to)",
  "CREATE INDEX IF NOT EXISTS idx_recorded_position ON triples(recorded_position, retracted_position)",
  "CREATE INDEX IF NOT EXISTS idx_entity_attr ON triples(entity_id, attribute) WHERE retracted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_tx_id ON triples(tx_id) WHERE retracted_at IS NULL",
] as const;

/**
 * Matches Datalog's shared number/datetime scalar expression. Include retracted
 * facts: snapshot-pinned pages can still see them at an earlier commit position.
 */
export const NUMERIC_VALUE_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_attr_numeric ON triples(attribute, COALESCE(value_number, value_datetime)) WHERE value_type IN ('number', 'datetime')";

/**
 * Blind-index lookups for sealed (sensitive) values: equality, joins and
 * uniqueness compare the keyed token, never plaintext. Includes retracted facts
 * so snapshot-pinned reads can use it.
 */
export const SEALED_BLIND_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_attr_blind ON triples(attribute, value_blind) WHERE value_type = 'sealed'";

/** Entity replay at a position must not scan all of that entity's later facts. */
export const ENTITY_RECORDED_POSITION_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_entity_recorded_position ON triples(entity_id, recorded_position)";

export const INDEX_DDLS = [
  ...BASELINE_INDEX_DDLS,
  NUMERIC_VALUE_INDEX_DDL,
  SEALED_BLIND_INDEX_DDL,
  ENTITY_RECORDED_POSITION_INDEX_DDL,
] as const;

/**
 * Index names for drop/recreate operations during bulk loading
 */
export const INDEX_NAMES = [
  "idx_entity",
  "idx_attribute",
  "idx_attribute_history",
  "idx_attribute_temporal",
  "idx_type",
  "idx_attr_string",
  "idx_attr_number",
  "idx_attr_numeric",
  "idx_attr_blind",
  "idx_ref_target",
  "idx_temporal",
  "idx_recorded_position",
  "idx_entity_recorded_position",
  "idx_entity_attr",
  "idx_tx_id",
] as const;

// =============================================================================
// Entity Snapshot Tables
// =============================================================================

/**
 * Content-addressed blob storage for entity snapshots.
 *
 * Each unique entity state (canonical JSON of attribute map) is stored once.
 * The hash is a `sha256-<64 hex>` ContentId over the entity-snapshot domain,
 * canonical version, and canonical JSON.
 * Deduplication is automatic — two entities with identical attributes share one blob.
 */
export const ENTITY_BLOBS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS entity_blobs (
    hash TEXT PRIMARY KEY NOT NULL,
    data TEXT NOT NULL,
    format_version INTEGER NOT NULL DEFAULT 1,
    byte_size INTEGER NOT NULL
  )
`;

/**
 * Entity snapshot pointers — one row per entity per transaction that touched it.
 *
 * The hash column references entity_blobs.hash (content address).
 * This table tracks the entity's state at each transaction point,
 * enabling O(1) change detection and time-travel entity reads.
 */
export const ENTITY_SNAPSHOTS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS entity_snapshots (
    entity_id TEXT NOT NULL,
    tx_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    tx_time BIGINT NOT NULL,
    tx_position BIGINT,
    entity_type TEXT,
    PRIMARY KEY (entity_id, tx_id)
  )
`;

/**
 * Indexes for entity snapshot queries.
 */
export const SNAPSHOT_INDEX_DDLS = [
  "CREATE INDEX IF NOT EXISTS idx_snapshot_entity ON entity_snapshots(entity_id, tx_time DESC)",
  "CREATE INDEX IF NOT EXISTS idx_snapshot_tx ON entity_snapshots(tx_id)",
  "CREATE INDEX IF NOT EXISTS idx_snapshot_hash ON entity_snapshots(hash)",
  "CREATE INDEX IF NOT EXISTS idx_snapshot_type ON entity_snapshots(entity_type, tx_time DESC)",
  "CREATE INDEX IF NOT EXISTS idx_snapshot_position ON entity_snapshots(entity_id, tx_position DESC, tx_time DESC)",
] as const;

// =============================================================================
// Sealed (sensitive) values — migration v3
// =============================================================================

const VALUE_TYPES_V3 = "'string', 'number', 'boolean', 'datetime', 'ref', 'json', 'blob', 'sealed'";

/**
 * The v3 `triples` shape: `sealed` joins the value types, and sealed values
 * keep their codec envelope in `value_sealed` and their blind-index token in
 * `value_blind`. Plaintext value columns stay NULL for sealed facts.
 */
const triplesTableDdlV3 = (name: string) => `
  CREATE TABLE IF NOT EXISTS ${name} (
    id TEXT PRIMARY KEY NOT NULL,
    entity_id TEXT NOT NULL,
    attribute TEXT NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN (${VALUE_TYPES_V3})),
    value_string TEXT,
    value_number DOUBLE PRECISION,
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
    tx_id TEXT,
    value_sealed TEXT,
    value_blind TEXT,
    CHECK (value_type <> 'sealed' OR value_sealed IS NOT NULL)
  )
`;

const V2_TRIPLES_COLUMNS =
  "id, entity_id, attribute, value_type, value_string, value_number, value_boolean, value_datetime, value_json, recorded_at, recorded_position, valid_from, valid_to, created_by, retracted_at, retracted_position, retract_tx_id, entity_type, schema_version, tx_id";

/**
 * SQLite cannot alter a CHECK constraint, so v3 rebuilds `triples` using the
 * documented create-copy-drop-rename procedure inside the migration
 * transaction, then recreates every index. Existing rows are copied unchanged.
 */
export const SEALED_VALUES_SQLITE_DDLS = [
  "DROP TABLE IF EXISTS triples_v3",
  triplesTableDdlV3("triples_v3"),
  `INSERT INTO triples_v3 (${V2_TRIPLES_COLUMNS}) SELECT ${V2_TRIPLES_COLUMNS} FROM triples`,
  "DROP TABLE triples",
  "ALTER TABLE triples_v3 RENAME TO triples",
  ...BASELINE_INDEX_DDLS,
  NUMERIC_VALUE_INDEX_DDL,
] as const;

/** PostgreSQL widens the inline value-type check in place. */
export const SEALED_VALUES_POSTGRES_DDLS = [
  "ALTER TABLE triples DROP CONSTRAINT IF EXISTS triples_value_type_check",
  `ALTER TABLE triples ADD CONSTRAINT triples_value_type_check CHECK (value_type IN (${VALUE_TYPES_V3}))`,
  "ALTER TABLE triples ADD COLUMN IF NOT EXISTS value_sealed TEXT",
  "ALTER TABLE triples ADD COLUMN IF NOT EXISTS value_blind TEXT",
  "ALTER TABLE triples DROP CONSTRAINT IF EXISTS triples_sealed_envelope_check",
  "ALTER TABLE triples ADD CONSTRAINT triples_sealed_envelope_check CHECK (value_type <> 'sealed' OR value_sealed IS NOT NULL)",
] as const;

/** Entries retain history; partial indexes contain only unacknowledged work. */
export const OPERATIONAL_ENTRIES_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS triplex_operational_entries (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('inbox', 'outbox')),
    scope TEXT NOT NULL,
    scope_token TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    recorded_position BIGINT NOT NULL,
    recorded_at BIGINT NOT NULL,
    tx_id TEXT NOT NULL,
    acknowledged_position BIGINT,
    acknowledged_at BIGINT,
    acknowledged_tx_id TEXT,
    CHECK ((acknowledged_position IS NULL AND acknowledged_at IS NULL AND acknowledged_tx_id IS NULL)
      OR (acknowledged_position IS NOT NULL AND acknowledged_at IS NOT NULL AND acknowledged_tx_id IS NOT NULL))
  )
`;
export const OPERATIONAL_ENTRIES_POSTGRES_TABLE_DDL = OPERATIONAL_ENTRIES_TABLE_DDL.replace(
  "id TEXT PRIMARY KEY",
  'id TEXT COLLATE "C" PRIMARY KEY',
);
export const OPERATIONAL_ENTRY_INDEX_DDLS = [
  `CREATE INDEX IF NOT EXISTS idx_operational_pending_global ON triplex_operational_entries (kind, recorded_position, id) WHERE acknowledged_position IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_operational_pending_scope ON triplex_operational_entries (kind, scope_token, recorded_position, id) WHERE acknowledged_position IS NULL`,
];
