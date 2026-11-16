/**
 * Builds a playground's database in the page: an in-memory KV store, the
 * bundle's types published as the live release, and its seed commands applied
 * as attributed, enforced transactions. The explorer service runs over it
 * unchanged, so the table, inspector, Why and journal behave as they do
 * against SQLite.
 */
import { EntityId, KvTriples, Triples, type TransactOp, type Triple } from "@triplex-internal/core";
import {
  Attribute,
  ConfigStore,
  EntityType,
  GraphConstraint,
  SchemaBound,
} from "@triplex-internal/core/config";
import type { DatalogQuery } from "@triplex-internal/core/datalog";
import { Why } from "@triplex-internal/core/why";
import { Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect";

import type { Transport } from "../app/client.js";
import { Explorer } from "../server/api.js";
import type { Basis, LiveEvent } from "../shared/protocol.js";
import type { AttributeSpec, Bundle, EntityWrite, TypeSpec } from "./bundle.js";

const DAY = 86_400_000;

/** An ISO date, epoch milliseconds, `today`, or a day offset from today such as `-30d`. */
export const instantOf = (value: string | number, now = Date.now()): number => {
  if (typeof value === "number") return value;
  const today = Math.floor(now / DAY) * DAY;
  if (value === "today") return today;
  const offset = /^([+-]\d+)d$/.exec(value);
  if (offset) return today + Number(offset[1]) * DAY;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`${JSON.stringify(value)} is not a date`);
  return parsed;
};

export const messageOf = (error: unknown): string => {
  if (typeof error !== "object" || error === null) return String(error);
  const record = error as Record<string, unknown>;
  const suggestion =
    typeof record["suggestion"] === "string" ? ` Did you mean ${record["suggestion"]}?` : "";
  if (typeof record["message"] === "string" && record["message"] !== "")
    return record["message"] + suggestion;
  const tag = typeof record["_tag"] === "string" ? record["_tag"] : String(error);
  return record["cause"] === undefined ? tag + suggestion : `${tag}: ${messageOf(record["cause"])}`;
};

const definitionOf = (
  type: string,
  alias: string,
  spec: AttributeSpec,
): Attribute.AnyDefinition => {
  switch (spec.type) {
    case "text":
      return Attribute.text(spec.key);
    case "number":
      return Attribute.number(spec.key);
    case "integer":
      return Attribute.integer(spec.key);
    case "boolean":
      return Attribute.boolean(spec.key);
    case "date":
      return Attribute.date(spec.key);
    case "instant":
      return Attribute.instant(spec.key);
    case "enum":
      if (!spec.values?.length) throw new Error(`${type}.${alias}: an enum needs "values"`);
      return Attribute.enumOf(spec.key, spec.values);
    case "ref":
      if (!spec.target) throw new Error(`${type}.${alias}: a ref needs a "target" type`);
      return Attribute.ref(spec.key, { entityType: spec.target });
  }
};

type AnyEntityType = EntityType.EntityType<string, any>;

const entityTypeOf = (spec: TypeSpec): AnyEntityType =>
  EntityType.make(
    spec.name,
    Object.fromEntries(
      Object.entries(spec.attributes).map(([alias, attribute]) => [
        alias,
        Attribute.use(definitionOf(spec.name, alias, attribute), {
          required: attribute.required ?? false,
          cardinality: attribute.many ? "many" : "one",
          unique: attribute.unique ?? false,
        }),
      ]),
    ),
  ) as AnyEntityType;

/** Instants may be written as dates; everything else is already in its declared shape. */
const valuesOf = (spec: TypeSpec, write: EntityWrite) =>
  Object.fromEntries(
    Object.entries(write.values).map(([alias, value]) => {
      const attribute = spec.attributes[alias];
      if (attribute === undefined)
        throw new Error(
          `${spec.name} has no attribute "${alias}" (it has ${Object.keys(spec.attributes).join(", ")})`,
        );
      const instant = (item: unknown) =>
        attribute.type === "instant" && (typeof item === "string" || typeof item === "number")
          ? instantOf(item)
          : item;
      return [alias, Array.isArray(value) ? value.map(instant) : instant(value)];
    }),
  );

export interface PlaygroundDatabase extends Transport {
  /** Problems found while building: an invalid type or a rejected seed command. */
  readonly problems: readonly string[];
  readonly commands: number;
  /** Runs a saved query at the explorer's basis, checking attributes against the release. */
  readonly query: (
    query: Record<string, unknown>,
    basis: Basis,
  ) => Promise<{ readonly rows: readonly Record<string, unknown>[]; readonly ms: number }>;
  readonly dispose: () => Promise<void>;
}

export const openPlayground = async (bundle: Bundle): Promise<PlaygroundDatabase> => {
  const database = ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer));
  const runtime = ManagedRuntime.make(
    Explorer.layer({ database: bundle.title || "Playground", readOnly: false }).pipe(
      Layer.provide(Why.layer),
      Layer.provideMerge(database),
    ),
  );
  const problems: string[] = [];
  let commands = 0;

  await runtime.runPromise(
    Effect.gen(function* () {
      const triples = yield* Triples;
      const config = yield* ConfigStore.ConfigStore;
      const specs = new Map(bundle.types.map((spec) => [spec.name, spec]));
      const types = new Map<string, AnyEntityType>();
      for (const spec of bundle.types) {
        const made = yield* Effect.try({
          try: () => entityTypeOf(spec),
          catch: (error) => `Type ${spec.name}: ${messageOf(error)}`,
        });
        types.set(spec.name, made);
      }
      if (types.size === 0) return yield* Effect.fail("Declare at least one entity type");
      const objects = yield* EntityType.nodesOf(...types.values()).pipe(
        Effect.mapError((error) => `Types: ${messageOf(error)}`),
      );
      yield* config
        .commit({ label: bundle.title || "playground", objects, ref: "live" })
        .pipe(Effect.mapError((error) => `Publishing the release: ${messageOf(error)}`));
      const release = (yield* config.resolveRef("live"))!;
      const pin = yield* GraphConstraint.pinned(release);

      for (const [index, command] of bundle.seed.entries()) {
        const label = `Seed command ${index + 1} (${command.actor})`;
        yield* Effect.gen(function* () {
          const at = command.at === undefined ? undefined : instantOf(command.at);
          const ops: TransactOp[] = [];
          const preconditions: NonNullable<
            Parameters<typeof triples.transact>[1]
          >["preconditions"] &
            unknown[] = [];
          const lookup = (write: EntityWrite) => {
            const type = types.get(write.type);
            if (type === undefined) throw new Error(`Unknown entity type ${write.type}`);
            return { type, spec: specs.get(write.type)! };
          };
          for (const write of command.create ?? []) {
            const { type, spec } = lookup(write);
            const validFrom = write.validFrom === undefined ? at : instantOf(write.validFrom);
            ops.push(
              ...type.assert(EntityId.make(write.id), valuesOf(spec, write), {
                ...(validFrom === undefined ? {} : { validFrom }),
                ...(write.validTo === undefined ? {} : { validTo: instantOf(write.validTo) }),
              }),
            );
          }
          for (const write of command.update ?? []) {
            const { type, spec } = lookup(write);
            const from =
              write.validFrom === undefined ? (at ?? Date.now()) : instantOf(write.validFrom);
            const id = EntityId.make(write.id);
            const facts: readonly Triple[] = yield* triples.entity(id, { validAt: from });
            if (facts.length === 0)
              throw new Error(`${write.id} has no facts valid at ${new Date(from).toISOString()}`);
            for (const [alias, value] of Object.entries(valuesOf(spec, write))) {
              const attribute = spec.attributes[alias]!;
              const current = facts.find((fact) => fact.attribute === attribute.key);
              if (attribute.many || current === undefined) {
                ops.push(...type.assert(id, { [alias]: value }, { validFrom: from }));
              } else {
                const change = type.replace(current, { [alias]: value } as never, from);
                ops.push(...change.ops);
                preconditions.push(...change.preconditions);
              }
            }
          }
          yield* triples.transact(ops, {
            actor: command.actor,
            commandId: command.commandId ?? `playground:seed:${index + 1}`,
            ...pin,
            ...(preconditions.length === 0 ? {} : { preconditions }),
          });
          commands++;
        }).pipe(
          Effect.catchDefect((defect) => Effect.fail(defect)),
          Effect.mapError((error) => `${label}: ${messageOf(error)}`),
        );
      }
    }).pipe(
      Effect.catch((problem) => Effect.sync(() => void problems.push(messageOf(problem)))),
      Effect.catchDefect((defect) => Effect.sync(() => void problems.push(messageOf(defect)))),
    ),
  );

  return {
    problems,
    commands,
    call: (request) =>
      runtime.runPromise(
        Effect.gen(function* () {
          return yield* (yield* Explorer).handle(request);
        }).pipe(Effect.mapError((error) => new Error(messageOf(error)))),
      ),
    follow: (after, onEvent, onConnection) => {
      const fiber = runtime.runFork(
        Effect.gen(function* () {
          const explorer = yield* Explorer;
          onConnection(true);
          yield* Stream.runForEach(explorer.live(after), (event: LiveEvent) =>
            Effect.sync(() => onEvent(event)),
          );
        }),
      );
      return () => void runtime.runFork(Fiber.interrupt(fiber));
    },
    query: (query, basis) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const started = performance.now();
          const triples = yield* Triples;
          const page = yield* triples.query(query as unknown as DatalogQuery, {
            pageSize: 200,
            basis: {
              ...(basis.recordedPosition === undefined
                ? {}
                : { recordedPosition: basis.recordedPosition }),
              ...(basis.validAt === undefined ? {} : { validAt: basis.validAt }),
            },
          });
          return { rows: page.results, ms: performance.now() - started };
        }).pipe(
          Effect.provide(SchemaBound.layer()),
          Effect.mapError((error) => new Error(messageOf(error))),
        ),
      ),
    dispose: () => runtime.dispose(),
  };
};
