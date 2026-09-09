import { Effect, type Scope } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { ReadError } from "@bjacobso/triplex";
import { makeDuckdbSnapshotStore, type DuckdbSnapshotService } from "../DuckdbSnapshot.js";
import {
  DATABASE_ATTRIBUTE,
  TENANT_ATTRIBUTE,
  TX_DATABASE_ATTRIBUTE,
  databaseEntity,
  federationFailure,
  type FactRow,
  type LocalDatabase,
  type ScanRequest,
} from "./types.js";

export interface SourceWorker {
  readonly metadata: DuckdbSnapshotService["metadata"];
  readonly pid: number;
  readonly scan: (request: ScanRequest) => Effect.Effect<readonly FactRow[], ReadError>;
}

/** The same immutable source implementation runs in-process or behind IPC. */
export const makeSource = (
  database: LocalDatabase,
  batchSize: number,
): Effect.Effect<SourceWorker, ReadError, Scope.Scope> =>
  Effect.gen(function* () {
    const snapshot = yield* makeDuckdbSnapshotStore({
      scope: database.id,
      ...(database.basis === undefined ? {} : { basis: database.basis }),
      batchSize,
      threads: 1,
    }).pipe(
      Effect.provide(
        SqliteClient.layer({ filename: database.filename, readonly: true, disableWAL: true }),
      ),
    );
    const { runner, metadata } = snapshot;
    const basis = metadata.basis;
    const params: unknown[] = [basis.recordedPosition, basis.validAt];
    const recorded = basis.recordedAt === undefined ? "" : " AND recorded_at <= $3";
    const retracted = basis.recordedAt === undefined ? "" : " OR retracted_at > $3";
    if (basis.recordedAt !== undefined) params.push(basis.recordedAt);
    // Materialize visibility at this source's own commit cut, before federation.
    yield* runner.run(
      `CREATE TABLE visible AS SELECT * FROM triples WHERE
    recorded_position <= $1 ${recorded}
    AND (retracted_position IS NULL OR retracted_position > $1 ${retracted})
    AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)`,
      params,
    );
    const reserved = yield* runner.run(
      `SELECT id FROM visible WHERE attribute IN ($1, $2, $3) LIMIT 1`,
      [DATABASE_ATTRIBUTE, TENANT_ATTRIBUTE, TX_DATABASE_ATTRIBUTE],
    );
    if (reserved.length)
      return yield* Effect.fail(
        federationFailure("Source contains reserved federation attributes"),
      );
    const columns = yield* runner.run<{ column_name: string }>("DESCRIBE triples", []);
    // Membership includes referenced identities and transactions, even if the requested
    // ordinary attribute is absent. It must not depend on the current scan's projection.
    yield* runner.run(
      `CREATE VIEW identities AS
    SELECT entity_id AS identity FROM visible UNION
    SELECT value_string FROM visible WHERE value_type = 'ref' UNION
    SELECT tx_id FROM visible WHERE tx_id IS NOT NULL`,
      [],
    );
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const virtual = (attribute: string, relation: string, identity: string) => {
      const expressions: Record<string, string> = {
        id: `${literal(`v:${attribute}:`)} || ${identity}`,
        entity_id: identity,
        attribute: literal(attribute),
        value_type: "'ref'",
        value_string: literal(databaseEntity(database.id)),
        recorded_at: "0",
        recorded_position: "0",
        valid_from: "0",
        schema_version: "1",
      };
      return `SELECT ${columns.map(({ column_name }) => `${expressions[column_name] ?? "NULL"} AS "${column_name}"`).join(",")} FROM ${relation}`;
    };
    yield* runner.run(
      `CREATE VIEW federation_facts AS
    SELECT ${columns.map(({ column_name }) => (column_name === "id" ? "'f:' || id AS id" : `"${column_name}"`)).join(",")} FROM visible
    UNION ALL ${virtual(DATABASE_ATTRIBUTE, "identities", "identity")}
    UNION ALL ${virtual(TX_DATABASE_ATTRIBUTE, "(SELECT DISTINCT tx_id FROM visible WHERE tx_id IS NOT NULL)", "tx_id")}`,
      [],
    );
    return {
      metadata,
      pid: process.pid,
      scan: (request: ScanRequest) => {
        const values: unknown[] = [];
        const conditions: string[] = [];
        if (request.after !== null) {
          values.push(request.after);
          conditions.push(`id > $${values.length}`);
        }
        if (request.attributes !== null) {
          if (request.attributes.length === 0) return Effect.succeed([]);
          conditions.push(
            `attribute IN (${request.attributes
              .map((attribute) => {
                values.push(attribute);
                return `$${values.length}`;
              })
              .join(",")})`,
          );
        }
        values.push(request.limit);
        return runner
          .run(
            `SELECT * FROM federation_facts ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY id LIMIT $${values.length}`,
            values,
          )
          .pipe(Effect.mapError(federationFailure));
      },
    };
  }).pipe(Effect.mapError(federationFailure));
