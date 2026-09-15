import { Context, Effect, Layer } from "effect";
import { Triples, type MigrationError } from "../../src/index.js";
import {
  Runtime,
  DatabaseScope,
  Capabilities,
  KvBackend,
  StorageAdapter,
  QueryExecutor,
  SnapshotService,
  SnapshotWriter,
  ChangeEmitter,
  entitySnapshots,
  changeEmission,
  type CapabilityError,
  type KvBackendService,
  type StorageAdapterService,
  type QueryExecutorService,
} from "../../src/runtime/index.js";

class Connection extends Context.Service<
  Connection,
  {
    readonly kv: KvBackendService;
    readonly storage: StorageAdapterService;
    readonly queries: QueryExecutorService;
  }
>()("type-test/Connection") {}

const backend: Layer.Layer<KvBackend, "connect-failed", Connection> = Layer.effect(
  KvBackend,
  Effect.map(Connection, (connection) => connection.kv),
);
const runtime = Runtime.fromKv({ name: "typed", backend });
const scope = DatabaseScope.test("types");
const minimal = runtime.layer({ scope, capabilities: Capabilities.none });
const options = { scope, capabilities: Capabilities.none };
export const checkedOptionsVariable: Layer.Layer<
  Triples,
  "connect-failed" | CapabilityError,
  Connection
> = runtime.layer(options);
export const checkedMinimal: Layer.Layer<Triples, "connect-failed" | CapabilityError, Connection> =
  minimal;
// @ts-expect-error A host-owned connection must remain a requirement.
export const lostConnection: Layer.Layer<Triples, "connect-failed" | CapabilityError> = minimal;
// @ts-expect-error Backend acquisition failures must remain typed.
export const lostError: Layer.Layer<Triples, CapabilityError, Connection> = minimal;
// @ts-expect-error Strings cannot stand in for validated database identities.
runtime.layer({ scope: "default" });
// @ts-expect-error No implicit database identity.
runtime.layer({ capabilities: Capabilities.none });

export const checkedDefault: Layer.Layer<
  Triples | SnapshotService | SnapshotWriter,
  "connect-failed" | CapabilityError,
  Connection | SnapshotService | SnapshotWriter | ChangeEmitter
> = runtime.layer({ scope });
// @ts-expect-error Default capabilities must not silently omit missing providers.
export const missingProviders: Layer.Layer<
  Triples,
  "connect-failed" | CapabilityError,
  Connection
> = runtime.layer({ scope });

const sql = Runtime.define({
  name: "sql",
  storage: Layer.effect(
    StorageAdapter,
    Effect.map(Connection, (c) => c.storage),
  ),
  queries: Layer.effect(
    QueryExecutor,
    Effect.map(Connection, (c) => c.queries),
  ),
});
export const checkedSql: Layer.Layer<Triples, MigrationError | CapabilityError, Connection> =
  sql.layer({ scope, capabilities: Capabilities.none });

declare const snapshots: Layer.Layer<
  SnapshotService | SnapshotWriter,
  "snapshot-failed",
  StorageAdapter | Triples
>;
const installed = Capabilities.of(entitySnapshots(snapshots), changeEmission());
export const checkedCapabilities: Layer.Layer<
  Triples | SnapshotService | SnapshotWriter,
  MigrationError | CapabilityError | "snapshot-failed",
  Connection | ChangeEmitter
> = sql.layer({ scope, capabilities: installed });
// @ts-expect-error Snapshot provider errors are not erased.
export const missingSnapshotError: Layer.Layer<
  Triples,
  MigrationError | CapabilityError,
  Connection | ChangeEmitter
> = sql.layer({ scope, capabilities: installed });
