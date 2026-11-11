/** Decode schema-bound, already-visible entity facts without opening sensitive values. */
import { Data, Effect, Option, Result, Schema } from "effect";
import { EntityId } from "../Branded.js";
import type { Triple } from "../Triple.js";
import * as CanonicalJson from "../content/CanonicalJson.js";
import type * as Attribute from "./Attribute.js";
import type { AttributeHandle } from "./EntityType.js";
import * as TypeSchema from "./TypeSchema.js";

/** Safe display marker; ciphertext and blind tokens are never included. */
export interface SealedMarker {
  readonly $sealed: { readonly valueType: string; readonly keyId: string };
}

export interface DecodeOptions {
  /** Count scalar facts (default), or deduplicate decoded values before checking ambiguity. */
  readonly scalarCardinality?: "facts" | "distinct";
  /**
   * Strict by default. Membership validates the aggregate type memberships, allowing
   * untyped facts and multiple subjects for callers that already selected their facts.
   */
  readonly factValidation?: "strict" | "membership";
  /** Include storage families and schema diagnostics in value errors; summary by default. */
  readonly valueDiagnostics?: "summary" | "detailed";
  /** Allow missing required aliases. Many aliases still return an empty array. */
  readonly allowPartial?: boolean;
  /** Include source facts by alias and undeclared facts separately. */
  readonly withFacts?: boolean;
  /** Undeclared attributes are ignored by default. */
  readonly unknownAttributes?: "ignore" | "reject";
}

type Uses = Readonly<Record<string, Attribute.Use<Attribute.AnyDefinition>>>;
/** Sealed storage remains sealed even after a declaration's sensitivity changes. */
type Value<D> =
  Attribute.ValueOf<D> extends EntityId
    ? EntityId
    : Exclude<Attribute.ValueOf<D>, Date> | SealedMarker;
type ReadValue<U, Partial extends boolean> =
  U extends Attribute.Use<infer D, infer C, infer R>
    ? C extends "many"
      ? ReadonlyArray<Value<D>>
      : Value<D> | (Partial extends true ? undefined : R extends true ? never : undefined)
    : never;

/** Every alias is present; absent optional scalars are undefined and many values are arrays. */
export type Decoded<A extends Uses, Partial extends boolean = false> = {
  readonly [P in keyof A]: ReadValue<A[P], Partial>;
};
type IsTrue<O, K extends PropertyKey> =
  O extends Record<K, true>
    ? true
    : O extends Record<K, false>
      ? false
      : K extends keyof O
        ? boolean
        : false;
export type DecodeResult<A extends Uses, O extends DecodeOptions = {}> =
  IsTrue<O, "withFacts"> extends false
    ? Decoded<A, IsTrue<O, "allowPartial">>
    : IsTrue<O, "withFacts"> extends true
      ? WithFacts<A, IsTrue<O, "allowPartial">>
      : Decoded<A, IsTrue<O, "allowPartial">> | WithFacts<A, IsTrue<O, "allowPartial">>;

export interface WithFacts<A extends Uses, Partial extends boolean = false> {
  readonly values: Decoded<A, Partial>;
  /** Original facts, preserving IDs and intervals for replace/end/correct. */
  readonly facts: { readonly [P in keyof A]: ReadonlyArray<Triple> };
  readonly unknownFacts: ReadonlyArray<Triple>;
}

export class EntityDecodeError extends Data.TaggedError("EntityDecodeError")<{
  readonly entityType: string;
  readonly entityId: EntityId | undefined;
  readonly alias: string | undefined;
  readonly reason:
    | "entity"
    | "entityType"
    | "cardinality"
    | "required"
    | "value"
    | "unknownAttribute";
  readonly message: string;
}> {}

/** Internal runtime implementation shared by all EntityType declarations. */
export const decode = (
  name: string,
  handles: Readonly<Record<string, AttributeHandle<Attribute.AnyDefinition>>>,
  facts: ReadonlyArray<Triple>,
  options: DecodeOptions = {},
): Effect.Effect<unknown, EntityDecodeError> =>
  Effect.gen(function* () {
    const entityId = facts[0]?.entityId;
    const fail = (reason: EntityDecodeError["reason"], message: string, alias?: string) =>
      new EntityDecodeError({ entityType: name, entityId, alias, reason, message });
    const detailed = options.valueDiagnostics === "detailed";
    const valueFailure = (summary: string, detail: string, alias: string) =>
      fail("value", detailed ? detail : summary, alias);
    if (options.factValidation === "membership") {
      const memberships = new Set(
        facts.flatMap((fact) => (Option.isSome(fact.entityType) ? [fact.entityType.value] : [])),
      );
      if (!memberships.has(name)) return yield* fail("entityType", `Entity is not a ${name}`);
      if ([...memberships].some((membership) => membership !== name))
        return yield* fail("entityType", "Mixed entity-type membership is not supported");
    }
    const groups = new Map<string, Triple[]>();
    const keys = new Set(Object.values(handles).map((h) => h.key));
    const unknownFacts: Triple[] = [];
    for (const fact of facts) {
      if (options.factValidation !== "membership" && fact.entityId !== entityId)
        return yield* fail("entity", "Facts must belong to one entity");
      if (
        options.factValidation !== "membership" &&
        (Option.isNone(fact.entityType) || fact.entityType.value !== name)
      ) {
        return yield* fail("entityType", `Every fact must belong to entity type ${name}`);
      }
      if (!keys.has(fact.attribute)) {
        if (options.unknownAttributes === "reject")
          return yield* fail("unknownAttribute", `Undeclared attribute ${fact.attribute}`);
        unknownFacts.push(fact);
      }
      const group = groups.get(fact.attribute) ?? [];
      group.push(fact);
      groups.set(fact.attribute, group);
    }
    // fromEntries also treats aliases such as __proto__ as ordinary own properties.
    const values: [string, unknown][] = [];
    const metadata: [string, ReadonlyArray<Triple>][] = [];
    for (const [alias, handle] of Object.entries(handles)) {
      const group = groups.get(handle.key) ?? [];
      if (
        options.scalarCardinality !== "distinct" &&
        handle.cardinality === "one" &&
        group.length > 1
      ) {
        return yield* fail("cardinality", "A scalar attribute has multiple visible facts", alias);
      }
      if (handle.required && group.length === 0 && !options.allowPartial) {
        return yield* fail("required", "A required attribute is missing", alias);
      }
      const stored: { identity: string; value: unknown }[] = [];
      for (const fact of group) {
        const value = fact.value;
        if (value.type === "sealed") {
          if (value.valueType !== handle.definition.valueType) {
            return yield* valueFailure(
              "Sealed storage type does not match the attribute",
              `Stored sealed ${value.valueType} value is incompatible with configured ${handle.definition.valueType} storage`,
              alias,
            );
          }
          stored.push({
            identity: `sealed:${value.blind ?? `opaque:${value.ciphertext}`}`,
            value: {
              $sealed: { valueType: value.valueType, keyId: value.keyId },
            } satisfies SealedMarker,
          });
        } else {
          if (handle.sensitive) {
            return yield* valueFailure(
              "Unsealed or incompatible stored value",
              "A sensitive attribute has an unsealed stored value; it is not returned",
              alias,
            );
          }
          if (value.type !== handle.definition.valueType) {
            return yield* valueFailure(
              "Unsealed or incompatible stored value",
              `Stored ${value.type} value is incompatible with configured ${handle.definition.valueType} storage`,
              alias,
            );
          }
          if (value.type === "ref" && !Schema.is(EntityId)(value.value)) {
            return yield* fail("value", "Stored reference is not a valid entity ID", alias);
          }
          const parsed = Schema.decodeUnknownResult(TypeSchema.compile(handle.type))(value.value);
          if (Result.isFailure(parsed))
            return yield* valueFailure(
              "Stored value does not satisfy the configured type",
              `Stored value does not satisfy the configured type: ${parsed.failure.message}`,
              alias,
            );
          const canonical = yield* CanonicalJson.encode(
            parsed.success as CanonicalJson.CanonicalValue,
          ).pipe(
            Effect.mapError((error) =>
              fail(
                "value",
                detailed ? String(error) : "Stored value is not canonical",
                detailed ? undefined : alias,
              ),
            ),
          );
          stored.push({ identity: `plain:${canonical}`, value: parsed.success });
        }
      }
      const distinct = [...new Map(stored.map((v) => [v.identity, v.value])).entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, value]) => value);
      if (handle.cardinality === "one" && distinct.length > 1) {
        return yield* fail(
          "cardinality",
          "A scalar attribute has multiple distinct live values",
          alias,
        );
      }
      values.push([alias, handle.cardinality === "many" ? distinct : distinct[0]]);
      metadata.push([alias, group]);
    }
    const decoded = Object.fromEntries(values);
    return options.withFacts
      ? { values: decoded, facts: Object.fromEntries(metadata), unknownFacts }
      : decoded;
  });
