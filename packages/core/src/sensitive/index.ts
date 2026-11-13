/**
 * Sensitive attribute values: sealed at rest through a pluggable codec, opened
 * only on purpose, and usable by Datalog for presence and keyed equality.
 *
 * ```ts
 * const ssn = Attribute.sensitive(Attribute.text(":person/ssn"))
 * const layer = Sensitive.layer({ database: "acme/main", attributes: [ssn] }).pipe(
 *   Layer.provide(ValueCodec.aesGcm),
 *   Layer.provide(KeyProvider.test({ seed: "test-only" })),
 *   Layer.provideMerge(backendTriplesLayer),
 * )
 * ```
 */

export * as Sensitive from "./Sensitive.js";
export * as ValueCodec from "./ValueCodec.js";
export * as KeyProvider from "./KeyProvider.js";
export * as RootKey from "./RootKey.js";
export { Sensitivity, type SensitivityService, type OpenOptions } from "./Sensitive.js";
export { SensitiveQueryError, SensitiveValueError } from "../errors/index.js";
export type { SealedValue, SealableValueType } from "../Value.js";
