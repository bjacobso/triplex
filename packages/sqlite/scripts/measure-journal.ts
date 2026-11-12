/** Issue-only measurement: no alternate journal mode is implemented. */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { EntityId, Triples, string, PatternClause } from "@triplex-internal/core";
import { CanonicalJson } from "@triplex-internal/core/content";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const triples = yield* Triples;
    const measurements = [];
    for (const payloadBytes of [16, 1024, 65536]) {
      const tx = yield* triples.transact([
        {
          op: "assert",
          entityId: EntityId.make(`measure:${payloadBytes}`),
          attribute: ":measure/value",
          value: string("x".repeat(payloadBytes)),
        },
      ]);
      const rows = yield* sql`SELECT attribute, value_json FROM triples WHERE tx_id = ${tx.txId}`;
      const changeRows = rows.filter((row) => row.attribute === ":_tx/change");
      const fullChangeJsonBytes = changeRows.reduce(
        (sum, row) => sum + Buffer.byteLength(String(row.value_json)),
        0,
      );
      // This is a proposed wire representation estimate, not an executed storage mode.
      const idOnlyJsonBytes = changeRows.reduce((sum, row) => {
        const change = JSON.parse(String(row.value_json));
        return (
          sum + Buffer.byteLength(JSON.stringify({ op: change.op, tripleId: change.tripleId }))
        );
      }, 0);
      measurements.push({
        payloadBytes,
        historyRows: rows.length,
        changeRows: changeRows.length,
        fullChangeJsonBytes,
        idOnlyJsonBytes,
        estimatedChangeJsonBytesSaved: fullChangeJsonBytes - idOnlyJsonBytes,
        estimatedRowsSavedIfKeepingOneIdOnlyRow: 0,
      });
    }
    return {
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
      node: process.version,
      measuredAt: new Date().toISOString(),
      databaseVersion: yield* sql`SELECT sqlite_version() AS version`,
      measurements,
      canonicalPublicExport: CanonicalJson.encodeOrThrow({
        z: -0,
        a: [undefined, 1],
        omitted: undefined,
      }),
      datalogPatterns: {
        threeTermsAccepted: Schema.is(PatternClause)(["?e", ":measure/value", "?v"]),
        fourTermsAccepted: Schema.is(PatternClause)(["?e", ":measure/value", "?v", "?tx"]),
        sixTermsAccepted: Schema.is(PatternClause)([
          "?e",
          ":measure/value",
          "?v",
          "?tx",
          "?validFrom",
          "?validTo",
        ]),
      },
    };
  }).pipe(Effect.provide(SqliteTriples.layerMemory)),
);
const output = JSON.stringify(result, null, 2) + "\n";
if (process.argv[2]) writeFileSync(process.argv[2], output);
else process.stdout.write(output);
