# Contributing

Triplex uses Node.js 22.19.0 or newer and pnpm 10.11.

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm pack:check
```

`pnpm check` runs formatting, linting, typechecking, unit tests, SQLite integration tests,
checked Markdown examples, and package builds. Self-contained TypeScript documentation examples
should use a `ts check` fence; `pnpm docs:check` compiles every marked block against the built
public package exports. Leave partial or illustrative fragments as ordinary `ts` fences.

The stress suite is intentionally opt-in:

```bash
pnpm --filter triplex-stress stress-test
```

PostgreSQL and FoundationDB integrations need external services or native libraries and are
also opt-in:

```bash
pnpm test:postgres:integration
pnpm test:foundationdb:integration
```

Changes to the temporal model, Datalog compiler/executors, SQL schema, transaction boundary,
pagination, database isolation, derivations, or graph constraints should run
`pnpm test:postgres:integration` before review. Changes to FoundationDB-specific code should also
run its integration suite when the native client is available.

All packages are ESM-only. Public exports must point to generated files under `dist`, and every
package change must continue to pass `pnpm pack:check` so source files, tests, caches, and local
dependencies never leak into npm tarballs.

Add a Changeset for a publishable package change. Release checks include a packed external consumer
and the PostgreSQL integration gate in CI. Current maturity and release gates live in
[`docs/current-state.md`](docs/current-state.md).

The seven public packages were bootstrapped with a short-lived npm token. Subsequent releases use
npm trusted publishing from GitHub owner `bjacobso`, repository `triplex`, workflow `release.yml`,
and the approval-protected `npm-publish` environment. Each package needs its own trusted publisher
connection with direct publishing allowed. The workflow grants `id-token: write` and uses an
OIDC-capable npm CLI.

Keep private packages out of Changeset frontmatter. Changesets cannot version a public release
when a Changeset mixes private and publishable packages.

## Dependency compatibility

The workspace tests Effect and its platform, SQL, and Vitest companions at 4.1.1,
with Foldkit and `@foldkit/ui` 0.170.0 and `@foldkit/vite-plugin` 0.29.0.
These Foldkit releases accept Effect `~4.1.0`, including the tested 4.1.1 patch;
no adapter overrides or peer exceptions are needed. The browser adapter is an
explicit catalog dependency of both the dashboard and the documentation workspace.
The Node platform adapters and Foldkit Vite plugin require Node.js 22.19.0 or
newer. Packages declare Effect and Foldkit runtimes and companions as compatible
ranges through `catalog:peers`, with exact development versions in the default catalog.
`pnpm pack:check` verifies the resolved tarball peer ranges against those tested versions
and installs them explicitly in a clean consumer. Peer checking remains enabled.
Alchemy 2.0.0-beta.80 and its Distilled dependencies declare Effect
`^4.0.0`, which includes 4.1.1. Alchemy still imports the removed `effect/Crypto`
module, including in beta.84. A pnpm patch migrates its OAuth state and PKCE
generation and service types to `SecureRandom` and `Digest` from `effect/crypto`,
and provides both services in its platform layer. `scripts/check-alchemy.mjs`
checks provider imports and PKCE generation without credentials or network calls
as part of `pnpm check`. Remove the patch when upstream supports these APIs.
Scoped catalog overrides pin Alchemy's D1 and Durable Object SQL companions to
4.1.1 within those supported ranges.

Effect 4.1.1's test adapter requires Vitest 5, so the catalog uses Vitest 5.0.4
and the compatible Cloudflare test plugin 1.4.0 and Workers types 5.20261006.1.
The two workerd test configs disable Vitest's host filesystem module cache because
those paths are unavailable inside the worker. Node test configs keep the default cache.
Alchemy 2.0.0-beta.80 supplies the stable Effect imports used by the existing stacks.
Validate dependency changes with a frozen install, `pnpm check`, `pnpm pack:check`,
and `pnpm test:e2e`; PostgreSQL and FoundationDB retain their integration gates above.
