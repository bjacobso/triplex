import { Data } from "effect";

/** The host must migrate its schema before acquiring an unmigrated layer. */
export class SchemaVersionError extends Data.TaggedError("SchemaVersionError")<{
  readonly expectedVersion: number;
  /** Zero means no migration history exists in the current schema. */
  readonly actualVersion: number;
}> {
  override get message(): string {
    return `Triplex requires schema version ${this.expectedVersion}, found ${this.actualVersion}. Run runMigrations from @triplex-build/triplex/sql before constructing the layer; use a compatible Triplex release if the schema is newer.`;
  }
}
