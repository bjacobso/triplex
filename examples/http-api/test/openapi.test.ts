import { KvTriples } from "@triplex-build/triplex";
import { ConfigStore } from "@triplex-build/triplex/config";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { format } from "oxfmt";
import { expect, it } from "vitest";

import { routes } from "../src/api.js";

it.each(["v1", "v2", "latest"])("preserves the served %s OpenAPI contract", async (version) => {
  const spec = await Effect.runPromise(
    Effect.gen(function* () {
      const web = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            routes.pipe(Layer.provide(ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer)))),
            { disableLogger: true },
          ),
        ),
        (web) => Effect.promise(() => web.dispose()),
      );
      const response = yield* Effect.promise(() =>
        web.handler(new Request(`http://triplex.test/api/rest/${version}/openapi.json`)),
      );
      expect(response.status).toBe(200);
      return yield* Effect.promise(() => response.json());
    }).pipe(Effect.scoped),
  );

  // Use the repository formatter so format:check and snapshot updates agree.
  // Preserve real snapshot IDs: fresh deployments have deterministic content identity.
  const formatted = await format(`${version}.json`, JSON.stringify(spec));
  expect(formatted.errors).toEqual([]);
  await expect(formatted.code).toMatchFileSnapshot(`./openapi/${version}.json`);
});
