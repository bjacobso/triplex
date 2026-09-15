import { Context, Effect, Layer } from "effect";
import { StorageAdapter } from "../storage/StorageAdapter.js";
import { QueryExecutor } from "../storage/QueryExecutor.js";
import { Triples } from "../store/Triples.js";
import { TriplesLive } from "../store/TriplesLive.js";
import { TripleStoreRuntime } from "../store/TripleStoreRuntime.js";
import {
  DeterministicTripleStoreRuntimeLive,
  makeTripleStoreRuntimeLayer,
} from "../store/TripleStoreRuntime.js";
import { composeStore, validateDependencies, CapabilityError } from "../store/StoreCapability.js";
import { KvBackend } from "../kv/kv/KvBackend.js";
import { KvTriplesLive } from "../kv/layers/KvTriplesLive.js";
import { Capabilities, type CapabilitySet } from "./Capabilities.js";
import { type DatabaseScope, validateDatabaseScope } from "./DatabaseScope.js";
import type { MigrationError } from "../errors/index.js";

export interface RuntimeOptions {
  readonly scope: DatabaseScope;
  readonly deterministic?: { readonly startTime: number; readonly seed: string };
}

type DefaultCapabilities = typeof Capabilities.default;
type DefaultOutput =
  DefaultCapabilities extends CapabilitySet<infer O, infer _E, infer _R> ? O : never;
type DefaultRequirements =
  DefaultCapabilities extends CapabilitySet<infer _O, infer _E, infer R> ? R : never;

export interface RuntimeDefinition<E, R, Provided = never> {
  readonly name: string;
  readonly layer: {
    (
      options: RuntimeOptions & { readonly capabilities?: never },
    ): Layer.Layer<Triples | DefaultOutput, E | CapabilityError, R | DefaultRequirements>;
    <O, CE, CR>(
      options: RuntimeOptions & { readonly capabilities: CapabilitySet<O, CE, CR> },
    ): Layer.Layer<
      Triples | O,
      E | CE | CapabilityError,
      R | Exclude<CR, Triples | TripleStoreRuntime | Provided>
    >;
  };
}

const definition = <E, R, Provided>(
  name: string,
  base: Layer.Layer<Triples | Provided, E, R | TripleStoreRuntime>,
): RuntimeDefinition<E, R, Provided> => {
  if (name.trim().length === 0) throw new TypeError("Runtime.name must be nonempty");

  function layer(
    options: RuntimeOptions & { readonly capabilities?: never },
  ): Layer.Layer<Triples | DefaultOutput, E | CapabilityError, R | DefaultRequirements>;
  function layer<O, CE, CR>(
    options: RuntimeOptions & { readonly capabilities: CapabilitySet<O, CE, CR> },
  ): Layer.Layer<
    Triples | O,
    E | CE | CapabilityError,
    R | Exclude<CR, Triples | TripleStoreRuntime | Provided>
  >;
  function layer(
    options: RuntimeOptions & { readonly capabilities?: CapabilitySet<never, unknown, unknown> },
  ): Layer.Layer<never, unknown, unknown> {
    validateDatabaseScope(options.scope);
    if (options.deterministic && !Number.isFinite(options.deterministic.startTime)) {
      throw new TypeError("deterministic.startTime must be finite");
    }
    const runtime = options.deterministic
      ? Layer.effect(
          TripleStoreRuntime,
          Effect.map(TripleStoreRuntime, (service) => ({
            ...service,
            scope: options.scope,
          })),
        ).pipe(
          Layer.provide(
            DeterministicTripleStoreRuntimeLive({
              now: options.deterministic.startTime,
              idSeed: options.deterministic.seed,
            }),
          ),
        )
      : makeTripleStoreRuntimeLayer(options.scope);
    const raw = base.pipe(Layer.provideMerge(runtime));
    const capabilities: CapabilitySet<never, unknown, unknown> =
      options.capabilities ?? Capabilities.default;
    return Layer.effectContext(
      Effect.gen(function* () {
        const context = yield* Layer.build(raw);
        const installed = yield* capabilities.build.pipe(Effect.provideContext(context));
        yield* Effect.try({
          try: () => validateDependencies(installed.capabilities),
          catch: (error) => {
            if (error instanceof CapabilityError) return error;
            throw error;
          },
        });
        const triples = yield* Effect.sync(() =>
          composeStore(Context.get(context, Triples), ...installed.capabilities),
        );
        return Context.add(installed.services, Triples, triples);
      }),
    );
  }
  return { name, layer };
};

const define = <SE, SR, QE, QR>(options: {
  readonly name: string;
  readonly storage: Layer.Layer<StorageAdapter, SE, SR>;
  readonly queries: Layer.Layer<QueryExecutor, QE, QR>;
}): RuntimeDefinition<SE | QE | MigrationError, SR | QR, StorageAdapter | QueryExecutor> =>
  definition<SE | QE | MigrationError, SR | QR, StorageAdapter | QueryExecutor>(
    options.name,
    TriplesLive.pipe(Layer.provideMerge(options.storage), Layer.provideMerge(options.queries)),
  );

const fromKv = <E, R>(options: {
  readonly name: string;
  readonly backend: Layer.Layer<KvBackend, E, R>;
}): RuntimeDefinition<E, R, KvBackend> =>
  definition<E, R, KvBackend>(
    options.name,
    KvTriplesLive.pipe(Layer.provideMerge(options.backend)),
  );

export const Runtime = { define, fromKv } as const;
