# Contributing

Triplex uses Node.js 22 or newer and pnpm 10.11.

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

The workspace tests Effect 4.0.3 with Foldkit and `@foldkit/ui` 0.168.0 and
`@foldkit/vite-plugin` 0.27.1. These Foldkit releases declare exact Effect 4.0.0 peers;
the plugin also pins the Node adapters to 4.0.0. `pnpm-workspace.yaml` allows only
4.0.3 for those specific package peers and overrides only the plugin's two adapter
dependencies. The browser adapter is an explicit catalog dependency of both the
dashboard and the documentation workspace. Remove these exceptions when upstream
peer ranges accept the tested patch. Peer checking remains enabled.

Effect 4.0.3's test adapter requires Vitest 5, so the catalog also uses Vitest 5.0.4
and the compatible Cloudflare test plugin 1.4.0 and Workers types 5.20261006.1.
The two workerd test configs disable Vitest's host filesystem module cache because
those paths are unavailable inside the worker. Node test configs keep the default cache.
Alchemy 2.0.0-beta.80 supplies the stable Effect imports used by the existing stacks.
Validate dependency changes with a frozen install, `pnpm check`, `pnpm pack:check`,
and `pnpm test:e2e`; PostgreSQL and FoundationDB retain their integration gates above.
