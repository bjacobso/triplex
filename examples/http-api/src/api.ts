import { Attribute, ConfigStore, EntityType } from "@bjacobso/triplex/config";
import { EntityHttp, HttpAuthorizationAllowAll } from "@bjacobso/triplex-http";
import { Effect, Layer } from "effect";

const EmployeeName = Attribute.text(":employee/name");
const EmployeeEmail = Attribute.text(":employee/email");

// First deployment: Employee has one exposed attribute.
const EmployeeV1 = EntityType.make("Employee", {
  attributes: { name: Attribute.use(EmployeeName, { required: true, unique: true }) },
});

// Second deployment: the persisted schema adds an optional email attribute.
const EmployeeV2 = EntityType.make("Employee", {
  attributes: {
    name: Attribute.use(EmployeeName, { required: true, unique: true }),
    email: Attribute.use(EmployeeEmail),
  },
});

export const routes = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* ConfigStore.ConfigStore;
    const v1 = yield* store.commit({
      label: "http-example-v1",
      objects: yield* EmployeeV1.nodes,
    });
    const v2 = yield* store.commit({
      label: "http-example-v2",
      objects: yield* EmployeeV2.nodes,
      ref: "live",
    });
    return EntityHttp.layer({
      basePath: "/api",
      docs: true,
      aliases: { v1: v1.snapshot.id, v2: v2.snapshot.id },
      exposure: { collections: { Employee: "employees" } },
    });
  }),
).pipe(Layer.provide(HttpAuthorizationAllowAll));
