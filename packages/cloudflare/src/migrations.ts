import {
  COMMAND_RECEIPTS_TABLE_DDL,
  COMMIT_POSITION_TABLE_DDL,
  INDEX_DDLS,
  TRIPLES_TABLE_DDL,
} from "./schema.js";
import {
  ENTITY_BLOBS_TABLE_DDL,
  ENTITY_SNAPSHOTS_TABLE_DDL,
  SNAPSHOT_INDEX_DDLS,
} from "@triplex-build/triplex-sql";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: ReadonlyArray<string>;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "triplex_baseline",
    up: [TRIPLES_TABLE_DDL, ...INDEX_DDLS, COMMIT_POSITION_TABLE_DDL, COMMAND_RECEIPTS_TABLE_DDL],
  },
  {
    version: 2,
    name: "triplex_entity_snapshots",
    up: [ENTITY_BLOBS_TABLE_DDL, ENTITY_SNAPSHOTS_TABLE_DDL, ...SNAPSHOT_INDEX_DDLS],
  },
];
