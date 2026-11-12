import {
  DatabaseId,
  DatalogValidationError,
  EntityId,
  KvTriples,
  TransactionId,
  TripleId,
  type TripleInput,
  type TriplesService,
} from "@triplex-build/triplex";
import { validateDatalogQuery, type DatalogQuery } from "@triplex-build/triplex/datalog";
import {
  Attribute,
  ConfigRuntime,
  ConfigStore,
  EntityType,
  EntityValidation,
  Evaluate,
  GraphConstraint,
  TypeExpr,
} from "@triplex-build/triplex/config";
import { Runtime, DatabaseScope, Capabilities } from "@triplex-build/triplex/runtime";
import * as Derivation from "@triplex-build/triplex/derivation";
import { LiveQuery } from "@triplex-build/triplex/live-query";
void LiveQuery;
import { Why } from "@triplex-build/triplex/why";
import * as Database from "@triplex-build/triplex/database";
import { Inbox, Outbox, OperationalEntryConflictError } from "@triplex-build/triplex/operational";
import { KeyProvider, Sensitive, ValueCodec } from "@triplex-build/triplex/sensitive";
import * as Cloudflare from "@triplex-build/triplex/cloudflare";
import * as FoundationDb from "@triplex-build/triplex/foundationdb";
import * as Host from "@triplex-build/triplex/host";
import * as Postgres from "@triplex-build/triplex/postgres";
import { PgTriples } from "@triplex-build/triplex/postgres";
import * as Sql from "@triplex-build/triplex/sql";
import { makeSqliteLayer } from "@triplex-build/triplex/sqlite";
import * as Testkit from "@triplex-build/triplex/testkit";
import { postgresSchemaLayer } from "@triplex-build/triplex/testkit/postgres";
import { EntityHttp, HttpAuthorizationAllowAll } from "@triplex-build/triplex/http";

const triple: TripleInput = {
  entityId: EntityId.make("person:alice"),
  attribute: ":person/name",
  value: { type: "string", value: "Alice" },
};
const transactionId = TransactionId.make("_tx/00000000000000000000000000");
const tripleId = TripleId.make("00000000000000000000000000");
const transactionEntity: EntityId = transactionId;
declare const triplesService: TriplesService;
const filteredFeed = triplesService.transactions({ entityIdPrefix: "home:", after: 0, limit: 10 });
const explainedLayer = Why.layer;
const retainedAssertion = triplesService.assertion(tripleId);
const timeline = triplesService.transactionsForEntity(triple.entityId, { limit: 20 });
const historicalEntity = triplesService.entity(triple.entityId, { recordedPosition: 0 });
const hostTransaction = PgTriples.withTransaction(triplesService.transact([]));
const intent = Outbox.append({
  scope: triple.entityId,
  idempotencyKey: "command:1",
  payload: { intent: true },
});
const incoming = Inbox.append({
  scope: triple.entityId,
  idempotencyKey: "message:1",
  payload: null,
});
const entryTransaction = triplesService.transact([
  intent,
  incoming,
  Outbox.acknowledge(Outbox.id(triple.entityId, "command:1")),
]);
const pendingEntries = Outbox.pending(triplesService, { scope: triple.entityId, limit: 10 });
const guardedWrite = triplesService.transact([], {
  preconditions: [
    {
      _tag: "AttributeValue",
      entityId: triple.entityId,
      attribute: triple.attribute,
      value: triple.value,
    },
    { _tag: "AttributeAbsent", entityId: triple.entityId, attribute: ":missing" },
    { _tag: "EntityAbsent", entityId: EntityId.make("new:entity") },
  ],
});
const kvLiveBackfill = KvTriples.migrateLiveFacts({ batchSize: 500 });
const entryHistory = Outbox.get(triplesService, Outbox.id(triple.entityId, "command:1"));
const operationalConflict = new OperationalEntryConflictError({
  entryId: Outbox.id(triple.entityId, "command:1"),
  kind: "outbox",
  scope: triple.entityId,
  idempotencyKey: "command:1",
  message: "conflicting payload",
});

const historicalQuery = triplesService.queryAll(
  { find: ["?value"], where: [[triple.entityId, ":person/name", "?value"]] },
  { basis: { recordedPosition: 0, validAt: 1 } },
);
const ambientPostgres = PgTriples.layerFromSqlClient({ scope: "host/database" });
const postgresFixture = postgresSchemaLayer({
  url: "postgresql://localhost/test",
  triples: PgTriples.layerFromSqlClient,
});
const schemaError = new Postgres.SchemaVersionError({ expectedVersion: 3, actualVersion: 2 });
const scopedPostgres = PgTriples.layerForDatabase(
  { database: "application" },
  DatabaseId.make("tenant-a"),
);
const query: DatalogQuery = {
  find: ["?name"],
  where: [["?person", ":person/name", "?name"]],
};
const EmployerName = Attribute.text(":employer/name");
const Employer = EntityType.make("Employer", {
  name: Attribute.use(EmployerName, { required: true }),
});
const nameAssertion = Employer.attributes.name.assertion("Acme");
const databaseLayer = Database.layer({ schema: { types: [Employer] } });
void databaseLayer;
const sensitiveLayer = Sensitive.layer({
  database: "tenant-a",
  attributes: [Attribute.sensitive(Attribute.text(":employee/ssn"))],
});
void triple;
void sensitiveLayer;
void ValueCodec.aesGcm;
void KeyProvider.test;
void transactionId;
void tripleId;
void transactionEntity;
void timeline;
void historicalEntity;
void hostTransaction;
void historicalQuery;
void ambientPostgres;
void postgresFixture;
void schemaError;
void scopedPostgres;
void query;
void validateDatalogQuery;
void DatalogValidationError;
void nameAssertion;
void ConfigStore;
void ConfigRuntime;
void Runtime;
void DatabaseScope;
void Capabilities;
void EntityValidation;
void Evaluate;
void GraphConstraint;
void TypeExpr;
void Derivation;
void Derivation.Materialization;
void Derivation.Overlay;
void makeSqliteLayer;
void Cloudflare;
void FoundationDb;
void Host;
void Postgres;
void Sql;
void Testkit;
void EntityHttp;
void HttpAuthorizationAllowAll;

void filteredFeed;
void explainedLayer;
void retainedAssertion;
void entryTransaction;
void pendingEntries;
void guardedWrite;
void kvLiveBackfill;
void entryHistory;
void operationalConflict;
