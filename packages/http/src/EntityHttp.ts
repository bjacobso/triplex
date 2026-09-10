import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";

import { HttpAuthorization } from "./Authorization.js";
import type { ExposureOptions } from "./ConfigApi.js";
import { handle } from "./EntityHttpHandlers.js";
import { EntityStore } from "./EntityStore.js";
import * as EntityStoreModule from "./EntityStore.js";
import { HandlerCache } from "./HandlerCache.js";
import * as HandlerCacheModule from "./HandlerCache.js";
import { VersionResolver } from "./VersionResolver.js";
import * as VersionResolverModule from "./VersionResolver.js";
import type { VersionOptions } from "./VersionResolver.js";

export interface Options extends VersionOptions {
  readonly basePath?: string;
  readonly exposure?: ExposureOptions;
  readonly docs?: boolean;
  readonly cacheCapacity?: number;
}

const normalizeBasePath = (input = "/api"): string => {
  const basePath = input.length > 1 ? input.replace(/\/$/, "") : input;
  if (
    !basePath.startsWith("/") ||
    basePath === "/" ||
    basePath
      .split("/")
      .slice(1)
      .some((segment) => !/^[A-Za-z0-9._~-]+$/.test(segment))
  ) {
    throw new TypeError("basePath must contain one or more safe absolute path segments");
  }
  return basePath;
};

/**
 * Mount the configuration-derived API into an Effect `HttpRouter`.
 *
 * The returned layer still requires host-provided `Triples`, `ConfigStore`, and
 * `HttpAuthorization` services. Backend and server allocation remain host-owned.
 */
export const layer = (options: Options = {}) => {
  const basePath = normalizeBasePath(options.basePath);
  const routes = HttpRouter.use((router) =>
    Effect.gen(function* () {
      const entityStore = yield* EntityStore;
      const resolver = yield* VersionResolver;
      const cache = yield* HandlerCache;
      const authorization = yield* HttpAuthorization;
      yield* router.add("*", `${basePath}/rest/*` as `/${string}`, (request) =>
        handle(request, {
          basePath,
          ...(options.exposure === undefined ? {} : { exposure: options.exposure }),
          ...(options.docs === undefined ? {} : { docs: options.docs }),
        }).pipe(
          Effect.provideService(EntityStore, entityStore),
          Effect.provideService(VersionResolver, resolver),
          Effect.provideService(HandlerCache, cache),
          Effect.provideService(HttpAuthorization, authorization),
        ),
      );
    }),
  );
  return routes.pipe(
    Layer.provide([
      EntityStoreModule.layer,
      VersionResolverModule.layer({
        ...(options.latestRef === undefined ? {} : { latestRef: options.latestRef }),
        ...(options.aliases === undefined ? {} : { aliases: options.aliases }),
        ...(options.activeWriteSnapshot === undefined
          ? {}
          : { activeWriteSnapshot: options.activeWriteSnapshot }),
      }),
      HandlerCacheModule.layer(options.cacheCapacity),
    ]),
  ) as Layer.Layer<
    never,
    never,
    | HttpRouter.HttpRouter
    | import("@triplex-build/triplex").Triples
    | import("@triplex-build/triplex/config").ConfigStore.ConfigStore
    | HttpAuthorization
  >;
};
