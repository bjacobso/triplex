import { Data } from "effect";

/**
 * The database's schema is not the one this release uses.
 *
 * `actualVersion` is zero when no Triplex schema exists: run `runMigrations`
 * (or use a migrating layer) first. Any other history, including every
 * database written by Triplex 0.4 or earlier, is refused: this release stores
 * the transaction journal in its own tables and does not migrate older
 * layouts. Start a fresh database.
 */
export class SchemaVersionError extends Data.TaggedError("SchemaVersionError")<{
  readonly expectedVersion: number;
  /** Zero means no migration history exists in the current schema. */
  readonly actualVersion: number;
  /** Name of the latest recorded migration, when there is one. */
  readonly actualName?: string;
}> {
  override get message(): string {
    if (this.actualVersion === 0) {
      return `Triplex requires schema version ${this.expectedVersion}, found no Triplex schema. Run runMigrations from @triplex-build/triplex/sql before constructing the layer.`;
    }
    return `Triplex requires schema version ${this.expectedVersion}, found version ${this.actualVersion}${this.actualName === undefined ? "" : ` (${this.actualName})`}. This database uses an incompatible storage layout: databases created by Triplex 0.4 or earlier keep the transaction journal in the triples table and cannot be opened or migrated by this release. Start a fresh database, or use the Triplex release that created it.`;
  }
}
