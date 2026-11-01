import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { makeOAuthClient } from "alchemy/Auth/OAuthFlow";
import { PlatformServices } from "alchemy/Util/PlatformServices";

// Import the provider used by both stacks without planning or deploying resources.
await import("alchemy/Cloudflare");

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
console.log("Verified Alchemy provider imports and OAuth PKCE with Effect 4.1 crypto services.");
