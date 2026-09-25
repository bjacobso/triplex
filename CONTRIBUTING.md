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
