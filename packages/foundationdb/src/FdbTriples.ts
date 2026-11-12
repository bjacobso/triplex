/**
 * One-line FoundationDB-backed `Triples` layer.
 *
 * ```ts
 * program.pipe(Effect.provide(FdbTriples.layer({ subspace: Buffer.from("app/") })))
 * ```
 *
 * Uses the merged KV `Triples` implementation (a single hexastore handle), so
 * writes and Datalog reads stay coherent. Create the layer once and share it.
 */

import { Layer } from "effect";
import {
  KvTriples,
  makeTripleStoreRuntimeLayer,
  RuntimeServicesLive,
} from "@triplex-internal/core/internal";
import { Sha256 } from "@triplex-internal/core/content";
import { makeFdbKvBackend, type FdbKvBackendConfig } from "./FdbKvBackend.js";

export const FdbTriples = {
  /** `Triples` backed by FoundationDB. */
  layer: (config: FdbKvBackendConfig = {}) =>
    KvTriples.layerBackend.pipe(
      Layer.provide(makeFdbKvBackend(config)),
      Layer.provide(
        makeTripleStoreRuntimeLayer(
          `foundationdb:${Sha256.hex(
            JSON.stringify([config.clusterFile ?? null, config.subspace?.toString("hex") ?? null]),
          )}`,
        ),
      ),
      Layer.provide(RuntimeServicesLive),
    ),
} as const;

export type FdbTriplesLayer = ReturnType<typeof FdbTriples.layer>;
