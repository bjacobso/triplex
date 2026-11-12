/** Compile-time regression: backend layers are interchangeable without exposing internals. */
import { Layer } from "effect";
import type { SqlClient } from "effect/sql";
import { DatabaseId, KvTriples, Triples } from "@triplex-build/triplex";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";
import { PgTriples } from "@triplex-build/triplex-postgres";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const exact = <L extends Layer.Any>(
  layer: L,
  _output: Equal<Layer.Success<L>, Triples>,
  _input: Equal<Layer.Services<L>, never>,
) => layer;

export const portableLayers: ReadonlyArray<Layer.Layer<Triples, unknown>> = [
  exact(KvTriples.layer, true, true),
  exact(KvTriples.layerWithScope("types"), true, true),
  exact(SqliteTriples.layer({ filename: "types.db" }), true, true),
  exact(SqliteTriples.layerMemory, true, true),
  exact(SqliteTriples.layerMemoryWithScope("types"), true, true),
  exact(PgTriples.layer({ database: "types" }), true, true),
  exact(PgTriples.layerFromUrl("postgres://localhost/types"), true, true),
];

const ambient = PgTriples.layerFromSqlClient({ scope: "types" });
const migrated = PgTriples.layerFromSqlClientMigrated({ scope: "types" });
const database = PgTriples.layerForDatabase({ database: "types" }, DatabaseId.make("types"));
const provisioned = PgTriples.layerForDatabaseMigrated(
  { database: "types" },
  DatabaseId.make("types"),
);

export const hostLayerTypes: [
  Equal<Layer.Success<typeof ambient>, Triples>,
  Equal<Layer.Services<typeof ambient>, SqlClient.SqlClient>,
  Equal<Layer.Success<typeof migrated>, Triples>,
  Equal<Layer.Services<typeof migrated>, SqlClient.SqlClient>,
  Equal<Layer.Success<typeof database>, Triples | SqlClient.SqlClient>,
  Equal<Layer.Services<typeof database>, never>,
  Equal<Layer.Success<typeof provisioned>, Triples | SqlClient.SqlClient>,
  Equal<Layer.Services<typeof provisioned>, never>,
] = [true, true, true, true, true, true, true, true];
