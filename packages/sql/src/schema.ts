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

import {
  JOURNAL_ATTRIBUTES_TABLE_DDLS,
  JOURNAL_FACTS_VIEW_DDL,
} from "@triplex-internal/core/internal";

export { JOURNAL_ATTRIBUTES_TABLE_DDLS, JOURNAL_FACTS_VIEW_DDL };

// =============================================================================
// Table Definitions
// =============================================================================

const VALUE_TYPES = "'string', 'number', 'boolean', 'datetime', 'ref', 'json', 'blob', 'sealed'";

/**
 * Triples table DDL
 *
 * Core table storing every application fact as an entity-attribute-value triple.
 * Supports:
 * - Multiple value types (string, number, boolean, datetime, ref, json, blob, sealed)
 * - Recorded-time history via recorded_at/retracted_at timestamps and positions
 * - Business-time history via valid_from/valid_to timestamps
 * - Entity typing for schema validation
 * - Transaction grouping via tx_id
 *
 * Sealed values keep their codec envelope in `value_sealed` and their
 * blind-index token in `value_blind`; plaintext value columns stay NULL. The
 * transaction journal is not stored here; see `TRANSACTIONS_TABLE_DDL`.
 */
export const TRIPLES_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS triples (
    id TEXT PRIMARY KEY NOT NULL,
    entity_id TEXT NOT NULL,
    attribute TEXT NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN (${VALUE_TYPES})),
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

/**
 * Schema migrations table DDL
 *
 * Records the applied schema. A database this release can open has exactly
 * one row: the baseline (see `migrations.ts`).
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

// =============================================================================
// Transaction journal
// =============================================================================

/**
 * One row per journaled transaction: its envelope and the ordered references
 * to the facts it changed (`changes`, a JSON array of `[tripleId, op]`).
 *
 * - `position` is unique: `transactions({ after })` seeks it.
 * - `command_id` is unique (NULLs allowed): first-writer-wins for commands and
 *   `transactionByCommand`.
 * - `idx_transactions_instant (instant, position)` resolves a recorded time to
 *   a position.
 *
 * The row, its entity rows and the facts commit in one backend transaction.
 */
export const TRANSACTIONS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS triplex_transactions (
    tx_id TEXT PRIMARY KEY NOT NULL,
    position BIGINT NOT NULL UNIQUE,
    instant BIGINT NOT NULL,
    actor TEXT,
    command_id TEXT UNIQUE,
    correlation_id TEXT,
    causation_id TEXT,
    config_snapshot TEXT,
    changes TEXT NOT NULL
  )
`;

export const TRANSACTIONS_INSTANT_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_transactions_instant ON triplex_transactions(instant, position)";

/**
 * One row per entity a journaled transaction changed. The primary key serves
 * an entity's transaction history and the entity-ID prefix feed as a range on
 * `entity_id`. PostgreSQL compares entity IDs bytewise (`COLLATE "C"`) so the
 * prefix range is exact.
 */
export const TRANSACTION_ENTITIES_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS triplex_transaction_entities (
    entity_id TEXT NOT NULL,
    position BIGINT NOT NULL,
    tx_id TEXT NOT NULL,
    PRIMARY KEY (entity_id, position)
  )
`;

export const TRANSACTION_ENTITIES_POSTGRES_TABLE_DDL = TRANSACTION_ENTITIES_TABLE_DDL.replace(
  "entity_id TEXT NOT NULL",
  'entity_id TEXT COLLATE "C" NOT NULL',
);

/**
 * Datalog joins a transaction to its changed entities (`[?tx
 * :_tx/changed-entity ?e]` with `?tx` bound) through the commit position.
 */
export const TRANSACTION_ENTITIES_POSITION_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_transaction_entities_position ON triplex_transaction_entities(position)";

/** The journal tables, the attribute table and the Datalog view over them. */
export const JOURNAL_DDLS: ReadonlyArray<string> = [
  TRANSACTIONS_TABLE_DDL,
  TRANSACTIONS_INSTANT_INDEX_DDL,
  TRANSACTION_ENTITIES_TABLE_DDL,
  TRANSACTION_ENTITIES_POSITION_INDEX_DDL,
  ...JOURNAL_ATTRIBUTES_TABLE_DDLS,
  JOURNAL_FACTS_VIEW_DDL,
];

// =============================================================================
// Index Definitions
// =============================================================================

/**
 * Indexes on the triples table. Each serves a fact read the plan fixtures pin:
 * - Entity lookups (idx_entity, idx_entity_attr)
 * - Attribute history and temporal scans (idx_attribute_history, idx_attribute_temporal)
 * - Type filtering (idx_type)
 * - Value searches (idx_attr_string, idx_attr_number)
 * - Reference traversal (idx_ref_target)
 * - Time travel queries (idx_temporal)
 * - Datalog's fourth term (idx_tx_id)
 */
export const BASELINE_INDEX_DDLS = [
  "CREATE INDEX IF NOT EXISTS idx_entity ON triples(entity_id) WHERE retracted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_attribute_history ON triples(attribute, recorded_position, retracted_position)",
  "CREATE INDEX IF NOT EXISTS idx_attribute_temporal ON triples(attribute, valid_from, valid_to) WHERE retracted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_type ON triples(entity_type) WHERE retracted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_attr_string ON triples(attribute, value_string) WHERE retracted_at IS NULL AND value_type = 'string'",
  "CREATE INDEX IF NOT EXISTS idx_attr_number ON triples(attribute, value_number) WHERE retracted_at IS NULL AND value_type = 'number'",
  "CREATE INDEX IF NOT EXISTS idx_ref_target ON triples(attribute, value_string, entity_id) WHERE retracted_at IS NULL AND value_type = 'ref'",
  "CREATE INDEX IF NOT EXISTS idx_temporal ON triples(entity_id, recorded_at, retracted_at, valid_from, valid_to)",
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

/** Non-partial indexes preserve interval access at historical recorded cuts. */
export const INTERVAL_HISTORY_INDEX_DDLS = [
  "CREATE INDEX IF NOT EXISTS idx_attribute_valid_to_history ON triples (attribute, valid_to, recorded_position)",
  "CREATE INDEX IF NOT EXISTS idx_attribute_valid_from_history ON triples (attribute, valid_from, recorded_position)",
] as const;

/** Covering metadata only: wildcard freshness. */
export const PUBLIC_READ_INDEX_DDLS = [
  "CREATE INDEX IF NOT EXISTS idx_dependency_all ON triples(recorded_position, retracted_position, recorded_at, retracted_at, valid_from, valid_to)",
] as const;

/** The current schema's `triples` indexes. */
export const INDEX_DDLS = [
  ...PUBLIC_READ_INDEX_DDLS,
  ...BASELINE_INDEX_DDLS,
  NUMERIC_VALUE_INDEX_DDL,
  SEALED_BLIND_INDEX_DDL,
  ENTITY_RECORDED_POSITION_INDEX_DDL,
  ...INTERVAL_HISTORY_INDEX_DDLS,
] as const;

/**
 * Index names for drop/recreate operations during bulk loading
 */
export const INDEX_NAMES = [
  "idx_dependency_all",
  "idx_entity",
  "idx_attribute_history",
  "idx_attribute_temporal",
  "idx_type",
  "idx_attr_string",
  "idx_attr_number",
  "idx_attr_numeric",
  "idx_attr_blind",
  "idx_ref_target",
  "idx_temporal",
  "idx_entity_recorded_position",
  "idx_entity_attr",
  "idx_tx_id",
  "idx_attribute_valid_to_history",
  "idx_attribute_valid_from_history",
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
// Operational entries
// =============================================================================

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

/** Expression statistics cover only live rows, avoiding historical attribute skew. */
export const LIVE_PRECONDITION_INDEX_POSTGRES_DDL = `CREATE INDEX IF NOT EXISTS idx_live_precondition_key
  ON triples ((length(entity_id)::text || ':' || entity_id || attribute)) WHERE retracted_at IS NULL`;

// =============================================================================
// Key store
// =============================================================================

/**
 * Data keys of the SQL key store (`SqlKeyStore`), one row per subject, key
 * class and version. The key is stored only wrapped under the host's root key
 * (`root_key_id` names it; the root key itself is never stored). Destroying a
 * key clears `wrapped_key` and sets `destroyed_at`; the row stays so the key ID
 * still resolves to "destroyed" rather than "unknown".
 */
export const DATA_KEYS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS triplex_data_keys (
    key_id TEXT PRIMARY KEY,
    database_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    key_class TEXT NOT NULL,
    version INTEGER NOT NULL,
    root_key_id TEXT,
    wrapped_key TEXT,
    created_at BIGINT NOT NULL,
    destroyed_at BIGINT,
    UNIQUE (database_id, subject, key_class, version),
    CHECK ((destroyed_at IS NULL) = (wrapped_key IS NOT NULL)),
    CHECK ((wrapped_key IS NULL) = (root_key_id IS NULL))
  )
`;

/** Rewrapping under a new root key finds the keys still wrapped under an old one. */
export const DATA_KEYS_ROOT_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_data_keys_root ON triplex_data_keys(root_key_id) WHERE root_key_id IS NOT NULL";

/**
 * Erased key scopes. `key_class` is `*` when every key class of the subject was
 * erased. New seals for an erased scope fail, so a key is never recreated for it.
 */
export const KEY_ERASURES_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS triplex_key_erasures (
    database_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    key_class TEXT NOT NULL,
    erased_at BIGINT NOT NULL,
    PRIMARY KEY (database_id, subject, key_class)
  )
`;

/**
 * Blind-index HMAC keys, one current version per database, wrapped like data
 * keys. Rotation stages the next version (`staged`), computes every token under
 * it, then activates it; a staged version is never current.
 */
export const BLIND_KEYS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS triplex_blind_keys (
    key_id TEXT PRIMARY KEY,
    database_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    root_key_id TEXT NOT NULL,
    wrapped_key TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    retired_at BIGINT,
    staged INTEGER NOT NULL DEFAULT 0,
    UNIQUE (database_id, version)
  )
`;

export const KEY_STORE_DDLS: ReadonlyArray<string> = [
  DATA_KEYS_TABLE_DDL,
  DATA_KEYS_ROOT_INDEX_DDL,
  KEY_ERASURES_TABLE_DDL,
  BLIND_KEYS_TABLE_DDL,
];
