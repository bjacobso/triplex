import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { makeOAuthClient } from "alchemy/Auth/OAuthFlow";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Contributions from "alchemy/Contributions";
import { evalStack } from "alchemy/Stack";
import { PlatformServices } from "alchemy/Util/PlatformServices";

// Compile the real deployment entrypoint without loading remote state or planning resources.
const { default: docsStack } = await import("../alchemy.run.ts");
const { default: hostStack } = await import("../examples/tenant-host-cloudflare/alchemy.run.ts");
assert.equal(hostStack.stackName, "triplex-tenant-host");
for (const stage of ["prod", "pr-123", "pr-456"]) {
  await Effect.runPromise(
    evalStack(
      docsStack,
      (stack) =>
        Effect.sync(() => {
          assert.equal(stack.name, "triplex");
          assert.equal(stack.stage, stage);
          const worker = stack.resources.Docs;
          assert.equal(worker.Type, "Cloudflare.Worker");
          assert.equal(
            worker.Props.name,
            stage === "prod" ? "triplex-docs" : `triplex-docs-${stage}`,
          );
          assert.equal(worker.Props.domain, stage === "prod" ? "triplex.build" : undefined);
          assert.equal(worker.Props.workersDev, true);
          assert.equal(worker.Props.assets.notFoundHandling, "404-page");
          assert.equal(worker.RemovalPolicy, "destroy");
        }),
      { stage },
    ).pipe(
      Effect.provideService(AlchemyContext, { dotAlchemy: ".alchemy", dev: false, adopt: false }),
      Effect.provide(PlatformServices),
    ),
  );
}

// Exercise beta.84's provider discovery and lazy state-store imports, used by `alchemy state`.
await Effect.runPromise(
  Effect.gen(function* () {
    const stores = yield* Contributions.stateStores();
    const { provider, store } = stores.get("cloudflare");
    assert.equal(provider.name, "cloudflare");
    const implementation = yield* store.load;
    assert.equal(typeof implementation.layer, "function");
    assert.equal(typeof implementation.lifecycle.bootstrap, "function");
    assert.equal(typeof implementation.lifecycle.teardown, "function");
    yield* provider.auth;
  }).pipe(Effect.provide(PlatformServices)),
);

const client = makeOAuthClient({
  clientId: "triplex-compatibility-check",
  endpoints: {
    authorize: "https://example.com/authorize",
    token: "https://example.com/token",
  },
  redirectUri: "https://example.com/callback",
  localCallbackUri: "http://127.0.0.1/callback",
  auth: { kind: "pkce" },
});
const [first, second] = await Effect.runPromise(
  Effect.all([client.authorize(["read"]), client.authorize(["read"])]).pipe(
    Effect.provide(PlatformServices),
    Effect.scoped,
  ),
);
for (const authorization of [first, second]) {
  const url = new URL(authorization.url);
  assert.match(authorization.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(authorization.verifier, /^[A-Za-z0-9_-]{128}$/);
  assert.equal(url.searchParams.get("state"), authorization.state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("code_challenge"),
    createHash("sha256").update(authorization.verifier).digest("base64url"),
  );
}
assert.notEqual(first.state, second.state);
assert.notEqual(first.verifier, second.verifier);
console.log(
  "Verified Alchemy stack isolation, state-store discovery, and OAuth PKCE with Effect 4.1.",
);
