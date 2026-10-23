import type { TransactAssertOp } from "../../src/Triple.js";
import { EntityId } from "../../src/Branded.js";
import * as Attribute from "../../src/config/Attribute.js";
import * as EntityType from "../../src/config/EntityType.js";

const Site = EntityType.make("Site", {
  attributes: { name: Attribute.use(Attribute.text(":site/name"), { required: true }) },
});

const options: Attribute.UseOptions = { cardinality: "many" };
const Worker = EntityType.make("Worker", {
  attributes: {
    name: Attribute.use(Attribute.text(":worker/name"), { required: true }),
    trainedFor: Attribute.use(Attribute.ref(":worker/trained-for", Site), { cardinality: "many" }),
    nickname: Attribute.use(Attribute.text(":worker/nickname"), options),
    active: Attribute.use(Attribute.boolean(":worker/active")),
  },
});

const maria = EntityId.make("worker:maria");
const harbor = EntityId.make("site:harbor");

// Use keeps the literal cardinality, and only an explicit `many` widens to arrays.
export const one: Attribute.Use<
  Attribute.Definition<":worker/name", string>,
  "one"
> = Attribute.use(Attribute.text(":worker/name"));
export const requiredOne: Attribute.Use<
  Attribute.Definition<":worker/name", string>,
  "one"
> = Attribute.use(Attribute.text(":worker/name"), { required: true });
// @ts-expect-error a non-literal options value leaves cardinality open
export const open: Attribute.Use<
  Attribute.Definition<":worker/name", string>,
  "one"
> = Attribute.use(Attribute.text(":worker/name"), options);
export const many: Attribute.Use<
  Attribute.Definition<":worker/name", string>,
  "many"
> = Attribute.use(Attribute.text(":worker/name"), { cardinality: "many" });

export const ops: ReadonlyArray<TransactAssertOp> = Worker.assert(
  maria,
  { name: "Maria", trainedFor: [harbor], active: true },
  { validFrom: 0, validTo: 1 },
);

// Every alias is optional and `undefined` is skipped, even with exactOptionalPropertyTypes.
const maybeName: string | undefined = undefined;
export const partial = Worker.assert(maria, { name: maybeName });

// A use whose cardinality is only known at runtime accepts either shape.
export const unknownShape = [
  Worker.assert(maria, { nickname: "M" }),
  Worker.assert(maria, { nickname: ["M", "Mar"] }),
];

// @ts-expect-error a cardinality-many attribute takes an array
Worker.assert(maria, { trainedFor: harbor });
// @ts-expect-error a cardinality-one attribute takes a single value
Worker.assert(maria, { name: ["Maria"] });
// @ts-expect-error values are typed by their attribute
Worker.assert(maria, { active: "yes" });
// @ts-expect-error aliases are closed
Worker.assert(maria, { title: "Supervisor" });
// @ts-expect-error entity ids are branded
Worker.assert("worker:maria", { name: "Maria" });
