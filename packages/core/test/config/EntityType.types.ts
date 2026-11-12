import { Effect } from "effect";
import type { TransactAssertOp } from "../../src/Triple.js";
import type { Triple } from "../../src/Triple.js";
import { EntityId } from "../../src/Branded.js";
import * as Attribute from "../../src/config/Attribute.js";
import * as EntityType from "../../src/config/EntityType.js";

const Site = EntityType.make("Site", {
  name: Attribute.use(Attribute.text(":site/name"), { required: true }),
});

const options: Attribute.UseOptions = { cardinality: "many" };
const Worker = EntityType.make("Worker", {
  name: Attribute.use(Attribute.text(":worker/name"), { required: true }),
  trainedFor: Attribute.use(Attribute.ref(":worker/trained-for", Site), { cardinality: "many" }),
  nickname: Attribute.use(Attribute.text(":worker/nickname"), options),
  active: Attribute.use(Attribute.boolean(":worker/active")),
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

// Modifiers keep literal cardinality, and a bare definition is a single optional value.
const Crew = EntityType.make("Crew", {
  name: Attribute.text(":crew/name").required({ unique: true }),
  sites: Attribute.ref(":crew/site", Site).many(),
  lead: Attribute.ref(":crew/lead", Worker).required(),
  night: Attribute.boolean(":crew/night"),
});
const crew = EntityId.make("crew:night");
export const crewOps = Crew.assert(crew, { name: "Night", sites: [harbor], lead: maria });
export const sitesOne: Attribute.Use<
  Attribute.Definition<":crew/site", EntityId>,
  "many"
> = Attribute.ref(":crew/site", Site).many();
// @ts-expect-error `many()` uses take arrays
Crew.assert(crew, { sites: harbor });
// @ts-expect-error bare definitions take a single value
Crew.assert(crew, { night: [true] });
// @ts-expect-error `required({ unique: true })` stays cardinality-one
Crew.assert(crew, { name: ["Night", "Late"] });
export const requiredMany: Attribute.Use<
  Attribute.Definition<":crew/name", string>,
  "many"
> = Attribute.text(":crew/name").required({ cardinality: "many" });

// Patterns accept variables or values typed by the attribute.
export const crewPatterns = [
  ...Crew.where("?crew", { sites: "?site", night: true }),
  Crew.not(crew, { sites: harbor }),
];
// @ts-expect-error pattern constants are typed by their attribute
Crew.where("?crew", { night: "yes" });
// @ts-expect-error pattern aliases are closed
Crew.where("?crew", { title: "?title" });
// @ts-expect-error the entity position is a variable or an entity id
Crew.where("crew", { night: true });

// Conditional temporal bounds work with exactOptionalPropertyTypes.
const maybeBound: number | undefined = undefined;
export const conditionalInterval = Worker.assert(
  maria,
  { name: "Maria" },
  {
    validFrom: maybeBound,
    validTo: maybeBound,
  },
);
export const conditionalAssertion = Worker.name.assertion("Maria", {
  validFrom: maybeBound,
  validTo: maybeBound,
});

// Changes target one fact, so even cardinality-many attributes take a single value.
declare const fact: Triple;
export const temporalChanges = [
  Worker.end(fact, 10),
  Worker.replace(fact, { name: "Maria" }, 10),
  Worker.correct(fact, { active: true }),
  Worker.replace(fact, { trainedFor: harbor }, 10),
];
// @ts-expect-error replacement values use the attribute's input type
Worker.replace(fact, { active: "yes" }, 10);
// @ts-expect-error a change targets exactly one alias
Worker.correct(fact, { name: "Maria", active: true });
// @ts-expect-error a change requires one alias
Worker.correct(fact, {});
// @ts-expect-error unknown aliases are rejected
Worker.correct(fact, { title: "Supervisor" });
// @ts-expect-error a single cardinality-many fact takes one value
Worker.correct(fact, { trainedFor: [harbor] });

// Read types retain requiredness, arrays, enums, refs, and normalized instants.
const ReadModel = EntityType.make("ReadModel", {
  required: Attribute.text(":read/required").required(),
  optional: Attribute.text(":read/optional"),
  many: Attribute.text(":read/many").many(),
  requiredMany: Attribute.text(":read/required-many").required({ cardinality: "many" }),
  explicit: Attribute.use(Attribute.boolean(":read/explicit"), { required: true }),
  state: Attribute.enumOf(":read/state", ["on", "off"]).required(),
  ref: Attribute.ref(":read/ref", Site).required(),
  instant: Attribute.instant(":read/instant").required(),
});
export const readTypes = Effect.gen(function* () {
  const value = yield* ReadModel.decode([]);
  const required: string | EntityType.SealedMarker = value.required;
  const optional: string | EntityType.SealedMarker | undefined = value.optional;
  const many: ReadonlyArray<string | EntityType.SealedMarker> = value.many;
  const requiredMany: ReadonlyArray<string | EntityType.SealedMarker> = value.requiredMany;
  const explicit: boolean | EntityType.SealedMarker = value.explicit;
  const state: "on" | "off" | EntityType.SealedMarker = value.state;
  const ref: EntityId = value.ref;
  const instant: number | EntityType.SealedMarker = value.instant;
  // @ts-expect-error optional scalars may be absent
  const absent: string | EntityType.SealedMarker = value.optional;
  // @ts-expect-error instants never decode as Date
  const date: Date = value.instant;
  const partial = yield* ReadModel.decode([], { allowPartial: true });
  // @ts-expect-error partial reads may omit required scalars
  const partialRequired: string | EntityType.SealedMarker = partial.required;
  const metadata = yield* ReadModel.decode([], { withFacts: true });
  const fact: Triple | undefined = metadata.facts.required[0];
  return {
    required,
    optional,
    many,
    requiredMany,
    explicit,
    state,
    ref,
    instant,
    absent,
    date,
    partialRequired,
    fact,
  };
});

// Every modifier retains the literal flag; broad options keep it unknown.
export const requiredFlag: true = Attribute.text(":read/a").required().required;
export const optionalFlag: false = Attribute.use(Attribute.text(":read/b")).required;
export const manyRequiredFlag: true = Attribute.text(":read/c").many({ required: true }).required;
export const uniqueRequiredFlag: true = Attribute.text(":read/d").unique({
  required: true,
}).required;
export const broadFlag: boolean = Attribute.use(Attribute.text(":read/e"), options).required;

// The Database front door retains each declaration's write and decoded read types.
import * as Database from "../../src/database/index.js";
declare const client: Database.DatabaseService;
declare const tx: Database.Command;
export const clientReadTypes = Effect.gen(function* () {
  const entity = yield* client.get(ReadModel, maria);
  if (entity) {
    const name: string | EntityType.SealedMarker = entity.values.required;
    const ref: EntityId = entity.values.ref;
    const many: ReadonlyArray<string | EntityType.SealedMarker> = entity.values.many;
    // @ts-expect-error sealed or normalized instants are never Date
    const instant: Date = entity.values.instant;
    return { name, ref, many, instant };
  }
  return null;
});
export const clientWrites = tx.put(Worker, maria, { name: "Maria", trainedFor: [harbor] });
// @ts-expect-error client values retain declaration alias types
tx.put(Worker, maria, { active: "yes" });
// @ts-expect-error client temporal edits take one scalar even for many-valued aliases
tx.correct(Worker, fact, { trainedFor: [harbor] });
// @ts-expect-error command metadata requires an actor
client.command({ commandId: "id" }, () => Effect.void);
