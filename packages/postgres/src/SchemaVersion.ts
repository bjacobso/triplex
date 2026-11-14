import { checkSchema, SchemaVersionError } from "@triplex-build/triplex-sql";

export { SchemaVersionError };

/**
 * Read-only preflight for unmigrated layers: the database must already have
 * this release's schema. Connection, permission, and malformed-history errors
 * remain SQL errors.
 */
export const checkSchemaVersion = checkSchema({ allowEmpty: false });

/** Preflight for migrating layers: an empty database is fine, an older layout is refused. */
export const refuseIncompatibleSchema = checkSchema({ allowEmpty: true });
