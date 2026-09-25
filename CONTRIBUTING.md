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

Add a Changeset for a publishable package change. Packages are not yet published, so the first
release must also validate a registry-only canary in a clean external consumer and retain the
existing PostgreSQL integration gate in CI. Current maturity and release gates live in
[`docs/current-state.md`](docs/current-state.md).

The first npm release needs a short-lived granular npm token with read/write publish access to the
`@triplex-build` scope and bypass 2FA enabled for unattended publishing. Organization-management
access is not needed. Add it as the `NPM_TOKEN` secret on the `npm-publish` GitHub environment before
approving the release job. After the packages exist, configure a trusted publisher on each npm
package for GitHub owner `bjacobso`, repository `triplex`, workflow `release.yml`, and environment
`npm-publish`, with direct publishing allowed. Then remove the bootstrap token. The workflow already
grants `id-token: write` and uses an OIDC-capable npm CLI for subsequent releases.

Keep private packages out of Changeset frontmatter. Changesets cannot version a public release
when a Changeset mixes private and publishable packages.
