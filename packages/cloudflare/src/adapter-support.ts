import type { TripleValue, ValueType } from "@triplex-build/triplex";
import {
  MigrationError,
  ReadError,
  StorageAdapter,
  type StorageAdapterService,
  WriteError,
} from "@triplex-build/triplex/internal";

export { StorageAdapter, type StorageAdapterService, MigrationError, ReadError, WriteError };

export {
  TRIPLES_TABLE_DDL,
  MIGRATIONS_TABLE_DDL,
  COMMIT_POSITION_TABLE_DDL,
  COMMAND_RECEIPTS_TABLE_DDL,
  INDEX_DDLS,
  INDEX_NAMES,
} from "./schema.js";
export { migrations, type Migration } from "./migrations.js";

export const packValue = (
  value: TripleValue,
): {
  value_type: ValueType;
  value_string: string | null;
  value_number: number | null;
  value_boolean: number | null;
  value_datetime: number | null;
  value_json: string | null;
} => {
  const base = {
    value_string: null as string | null,
    value_number: null as number | null,
    value_boolean: null as number | null,
    value_datetime: null as number | null,
    value_json: null as string | null,
  };

  switch (value.type) {
    case "string":
      return { ...base, value_type: "string", value_string: value.value };
    case "number":
      return { ...base, value_type: "number", value_number: value.value };
    case "boolean":
      return { ...base, value_type: "boolean", value_boolean: value.value ? 1 : 0 };
    case "datetime":
      return { ...base, value_type: "datetime", value_datetime: value.value };
    case "ref":
      return { ...base, value_type: "ref", value_string: value.value };
    case "json":
      return { ...base, value_type: "json", value_json: JSON.stringify(value.value) };
    case "blob":
      return {
        ...base,
        value_type: "blob",
        value_string: value.value,
        value_json: JSON.stringify({
          mimeType: value.mimeType,
          size: value.size,
          ...(value.filename && { filename: value.filename }),
        }),
      };
  }
};
