/**
 * One-line FoundationDB-backed `Triples` layer.
 *
 * ```ts
 * program.pipe(Effect.provide(FdbTriples.layer({ subspacePrefix: "app" })))
 * ```
 *
 * Uses the merged KV `Triples` implementation (a single hexastore handle), so
 * writes and Datalog reads stay coherent. Create the layer once and share it.
 */

import { Layer } from "effect";
import {
  KvTriples,
  TripleStoreRuntimeLayer,
  RuntimeServicesLive,
} from "@triplex-build/triplex/internal";
import { makeFdbKvBackend, type FdbKvBackendConfig } from "./FdbKvBackend.js";

export const FdbTriples = {
  /** `Triples` backed by FoundationDB. */
  layer: (config: FdbKvBackendConfig = {}) =>
    KvTriples.layerBackend.pipe(
      Layer.provide(makeFdbKvBackend(config)),
      Layer.provide(TripleStoreRuntimeLayer),
      Layer.provide(RuntimeServicesLive),
    ),
} as const;

export type FdbTriplesLayer = ReturnType<typeof FdbTriples.layer>;
