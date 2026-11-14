/**
 * SQL sources that present the transaction journal tables as triple-shaped rows.
 *
 * The journal lives in `triplex_transactions` (one row per transaction) and
 * `triplex_transaction_entities` (one row per changed entity). Datalog still
 * reads the reserved `:_tx/*` attributes as facts of the transaction entity:
 * a pattern with a constant `:_tx/*` attribute reads that attribute's source
 * below, and a pattern with a variable attribute reads `triples` and the
 * `triplex_journal_facts` view. Every source has the columns the Datalog
 * compiler reads, with the types of the `triples` columns, so they can also be
 * combined with `UNION ALL`.
 *
 * Each source is a single SELECT (no UNION), which SQLite flattens into the
 * enclosing query; a join on the transaction entity therefore seeks the
 * transaction's primary key instead of materializing the journal.
 */
import { TxAttributes } from "../utils/id.js";

export const JOURNAL_TRANSACTIONS_TABLE = "triplex_transactions";
export const JOURNAL_ENTITIES_TABLE = "triplex_transaction_entities";
export const JOURNAL_ATTRIBUTES_TABLE = "triplex_journal_attributes";
export const JOURNAL_FACTS_VIEW = "triplex_journal_facts";

/** The reserved transaction metadata attributes, in their documented order. */
export const JOURNAL_ATTRIBUTES = [
  TxAttributes.POSITION,
  TxAttributes.INSTANT,
  TxAttributes.ACTOR,
  TxAttributes.COMMAND_ID,
  TxAttributes.CORRELATION_ID,
  TxAttributes.CAUSATION_ID,
  TxAttributes.CONFIG_SNAPSHOT,
  TxAttributes.CHANGED_ENTITY,
] as const;

/** Columns of every triple-shaped source, in `UNION ALL` order. */
export const FACT_SOURCE_COLUMNS = [
  "id",
  "entity_id",
  "attribute",
  "value_type",
  "value_string",
  "value_number",
  "value_boolean",
  "value_datetime",
  "value_json",
  "value_sealed",
  "value_blind",
  "recorded_at",
  "recorded_position",
  "valid_from",
  "valid_to",
  "created_by",
  "retracted_at",
  "retracted_position",
  "retract_tx_id",
  "entity_type",
  "tx_id",
] as const;

const text = (value: string) => `CAST('${value}' AS TEXT)`;
const NULL_TEXT = "CAST(NULL AS TEXT)";
const NULL_BIGINT = "CAST(NULL AS BIGINT)";
const NULL_NUMBER = "CAST(NULL AS DOUBLE PRECISION)";
const NULL_INTEGER = "CAST(NULL AS INTEGER)";

/** Metadata column of `triplex_transactions` for each string attribute. */
const STRING_COLUMNS: Readonly<Record<string, string>> = {
  [TxAttributes.ACTOR]: "actor",
  [TxAttributes.COMMAND_ID]: "command_id",
  [TxAttributes.CORRELATION_ID]: "correlation_id",
  [TxAttributes.CAUSATION_ID]: "causation_id",
  [TxAttributes.CONFIG_SNAPSHOT]: "config_snapshot",
};

interface SourceColumns {
  readonly id: string;
  readonly attribute: string;
  readonly valueType: string;
  readonly valueString: string;
  readonly valueNumber: string;
  readonly valueDatetime: string;
}

/** The SELECT list over `t` (transactions), in FACT_SOURCE_COLUMNS order. */
const selectList = (columns: SourceColumns): string =>
  [
    `${columns.id} AS id`,
    "t.tx_id AS entity_id",
    `${columns.attribute} AS attribute`,
    `${columns.valueType} AS value_type`,
    `${columns.valueString} AS value_string`,
    `${columns.valueNumber} AS value_number`,
    `${NULL_INTEGER} AS value_boolean`,
    `${columns.valueDatetime} AS value_datetime`,
    `${NULL_TEXT} AS value_json`,
    `${NULL_TEXT} AS value_sealed`,
    `${NULL_TEXT} AS value_blind`,
    "t.instant AS recorded_at",
    "t.position AS recorded_position",
    "t.instant AS valid_from",
    `${NULL_BIGINT} AS valid_to`,
    `${NULL_TEXT} AS created_by`,
    `${NULL_BIGINT} AS retracted_at`,
    `${NULL_BIGINT} AS retracted_position`,
    `${NULL_TEXT} AS retract_tx_id`,
    `${text("_Transaction")} AS entity_type`,
    "t.tx_id AS tx_id",
  ].join(", ");

/** The single-attribute source as a SELECT, or undefined for an unknown attribute. */
const attributeSelect = (attribute: string): string | undefined => {
  const base = {
    id: `t.tx_id || '#${attribute}'`,
    attribute: text(attribute),
    valueType: text("string"),
    valueString: NULL_TEXT,
    valueNumber: NULL_NUMBER,
    valueDatetime: NULL_BIGINT,
  };
  switch (attribute) {
    case TxAttributes.POSITION:
      return `SELECT ${selectList({
        ...base,
        valueType: text("number"),
        valueNumber: "CAST(t.position AS DOUBLE PRECISION)",
      })} FROM ${JOURNAL_TRANSACTIONS_TABLE} t`;
    case TxAttributes.INSTANT:
      return `SELECT ${selectList({
        ...base,
        valueType: text("datetime"),
        valueDatetime: "t.instant",
      })} FROM ${JOURNAL_TRANSACTIONS_TABLE} t`;
    case TxAttributes.CHANGED_ENTITY:
      return `SELECT ${selectList({
        ...base,
        id: `t.tx_id || '#${attribute}#' || e.entity_id`,
        valueType: text("ref"),
        valueString: "e.entity_id",
      })} FROM ${JOURNAL_ENTITIES_TABLE} e JOIN ${JOURNAL_TRANSACTIONS_TABLE} t ON t.position = e.position`;
    default: {
      const column = STRING_COLUMNS[attribute];
      return column === undefined
        ? undefined
        : `SELECT ${selectList({ ...base, valueString: `t.${column}` })} FROM ${JOURNAL_TRANSACTIONS_TABLE} t WHERE t.${column} IS NOT NULL`;
    }
  }
};

/**
 * The FROM item for a pattern whose attribute is the constant `attribute`.
 * Application attributes and unknown reserved `:_tx/*` attributes (such as
 * the retired `:_tx/change`, which no row carries) read `triples`.
 */
export const constantAttributeSource = (attribute: string): string => {
  if (!attribute.startsWith(":_tx/")) return "triples";
  const select = attributeSelect(attribute);
  return select === undefined ? "triples" : `(${select})`;
};

/** `CASE` over `a.attribute` choosing each attribute's expression. */
const byAttribute = (cases: Readonly<Record<string, string>>, otherwise: string): string =>
  `CASE a.attribute ${Object.entries(cases)
    .map(([attribute, expression]) => `WHEN '${attribute}' THEN ${expression}`)
    .join(" ")} ELSE ${otherwise} END`;

const viewValueString = byAttribute(
  {
    ...Object.fromEntries(
      Object.entries(STRING_COLUMNS).map(([attribute, column]) => [attribute, `t.${column}`]),
    ),
    [TxAttributes.CHANGED_ENTITY]: "e.entity_id",
  },
  NULL_TEXT,
);

/**
 * Every journal attribute as one single SELECT: each transaction crossed with
 * the attribute table, and changed entities joined for their attribute. Absent
 * metadata (no actor, no changed entity) yields no row.
 */
export const JOURNAL_FACTS_VIEW_DDL = `CREATE VIEW ${JOURNAL_FACTS_VIEW} AS SELECT ${selectList({
  id: `t.tx_id || '#' || a.attribute || COALESCE('#' || e.entity_id, '')`,
  attribute: "a.attribute",
  valueType: byAttribute(
    {
      [TxAttributes.POSITION]: text("number"),
      [TxAttributes.INSTANT]: text("datetime"),
      [TxAttributes.CHANGED_ENTITY]: text("ref"),
    },
    text("string"),
  ),
  valueString: viewValueString,
  valueNumber: byAttribute(
    { [TxAttributes.POSITION]: "CAST(t.position AS DOUBLE PRECISION)" },
    NULL_NUMBER,
  ),
  valueDatetime: byAttribute({ [TxAttributes.INSTANT]: "t.instant" }, NULL_BIGINT),
})} FROM ${JOURNAL_TRANSACTIONS_TABLE} t JOIN ${JOURNAL_ATTRIBUTES_TABLE} a ON 1 = 1 LEFT JOIN ${JOURNAL_ENTITIES_TABLE} e ON a.attribute = '${TxAttributes.CHANGED_ENTITY}' AND e.position = t.position WHERE a.attribute IN ('${TxAttributes.POSITION}', '${TxAttributes.INSTANT}') OR ${viewValueString} IS NOT NULL`;

/** The attribute table the view crosses with each transaction, and its rows. */
export const JOURNAL_ATTRIBUTES_TABLE_DDLS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${JOURNAL_ATTRIBUTES_TABLE} (attribute TEXT PRIMARY KEY NOT NULL)`,
  ...JOURNAL_ATTRIBUTES.map(
    (attribute) => `INSERT INTO ${JOURNAL_ATTRIBUTES_TABLE} (attribute) VALUES ('${attribute}')`,
  ),
];

/** Facts and journal metadata together, for plans that cannot split a variable attribute. */
export const ALL_FACTS_SOURCE = `(SELECT ${FACT_SOURCE_COLUMNS.join(", ")} FROM triples UNION ALL SELECT ${FACT_SOURCE_COLUMNS.join(", ")} FROM ${JOURNAL_FACTS_VIEW})`;
