# Releasing Triplex

Triplex publishes one npm package, `@triplex-build/triplex`, through Changesets and
GitHub Actions. All implementation workspaces are private and ignored by Changesets.

## Release set and packing from main

After cloning `main`, install and pack from the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm pack
```

The prepack hook builds the private module graph and dashboard, then emits one
`triplex-build-triplex-<version>.tgz`. It contains the existing core exports plus
`/sql`, `/sqlite`, `/postgres`, `/cloudflare`, `/foundationdb`, `/host`, `/http`,
`/testkit`, `/testkit/postgres`, `/mcp` and `/runner`, and the `triplex` executable. Dashboard
JavaScript, CSS and fonts are prebuilt assets; consumers install no UI runtime.
Cloudflare and FoundationDB remain **experimental and frozen** even though their
subpaths now ship.

Only `effect` is a required peer. Install the backend driver separately:

```sh
npm install @triplex-build/triplex effect @effect/sql-sqlite-node
# PostgreSQL instead:
npm install @triplex-build/triplex effect @effect/sql-pg
```

The bin's Node services also need `@effect/platform-node` and
`@effect/platform-node-shared`, both optional peers. Library-only and browser
consumers do not need them. `pnpm pack:check` verifies the effect-only consumer,
then installs the SQLite driver and Node adapters to exercise the bin and server.

## Deprecate the old npm names after the consolidated release

Ben should publish and verify the unified release before deprecating all versions
of these six names. Do not unpublish any artifacts. Use these exact messages:

| Old npm package                   | Deprecation message                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `@triplex-build/triplex-sql`      | Use @triplex-build/triplex/sql from the single @triplex-build/triplex package.                                                |
| `@triplex-build/triplex-sqlite`   | Use @triplex-build/triplex/sqlite from the single @triplex-build/triplex package; install @effect/sql-sqlite-node separately. |
| `@triplex-build/triplex-postgres` | Use @triplex-build/triplex/postgres from the single @triplex-build/triplex package; install @effect/sql-pg separately.        |
| `@triplex-build/triplex-http`     | Use @triplex-build/triplex/http from the single @triplex-build/triplex package.                                               |
| `@triplex-build/triplex-testkit`  | Use @triplex-build/triplex/testkit (or /testkit/postgres) from the single @triplex-build/triplex package.                     |
| `@triplex-build/triplex-cli`      | Install @triplex-build/triplex for the triplex bin; use triplex mcp and triplex dashboard for the bundled tools.              |

For each row, the owner can run `npm deprecate '<old-name>@*' '<message>'` after
verifying the new paths. Cloudflare, FoundationDB, host, MCP and dashboard were
never published under the old workspace names and need no npm deprecation.

## Required repository configuration

Create a GitHub environment named `npm-publish` and require maintainer approval for it. Protect
`main` with the Node 22, Node 24, package-consumer, and PostgreSQL integration jobs from CI.
Repository Actions settings must allow GitHub Actions to create pull requests so the version job
can maintain the release PR.

The release workflow uses npm trusted publishing. The single public package needs this trusted publisher:

| Field       | Value         |
| ----------- | ------------- |
| Owner       | `bjacobso`    |
| Repository  | `triplex`     |
| Workflow    | `release.yml` |
| Environment | `npm-publish` |

Allow direct `npm publish` for this workflow. It runs on a GitHub-hosted runner with
`id-token: write`; npm therefore issues a short-lived OIDC credential and records provenance.

## One-time npm bootstrap

npm package settings do not exist until the package has first been created. The seven public
packages were bootstrapped under `@triplex-build` with a token, and 0.2.0 was still published with
it. Since 0.3.0, releases use GitHub Actions OIDC without an npm token: the publish job has no token
in its environment, and npm records provenance. The leftover `NPM_TOKEN` repository secret is no
longer used; delete it and revoke its token.

For a new package added to the family, repeat the minimal bootstrap sequence:

1. Authenticate as an npm owner of the `@triplex-build` organization and confirm the new name is
   available.
2. Create a granular token limited to the new package with publish access and the minimum useful
   lifetime. Temporarily add token authentication to the protected release job for its first publish.
3. Publish its first version under the `next` dist-tag and verify the package record exists.
4. Configure its trusted publisher using the values above.
5. Remove the temporary token authentication, delete its GitHub secret, and revoke the token.
6. Verify the next publish uses OIDC.

Do not put an npm token in the repository, a shell command, or a checked-in `.npmrc`.

The six pre-stable packages under `@bjacobso` are a superseded bootstrap line. After the
`@triplex-build` stable release is available, deprecate every old version with a message directing
consumers to its corresponding `@triplex-build` package. Do not unpublish the old artifacts.

## Documentation deployment

The VitePress site is deployed to Cloudflare as an assets-only Worker with the Effect-native
Alchemy stack in `alchemy.run.ts`. Inspect the production infrastructure diff with `pnpm docs:plan`.
Deployments run through GitHub Actions.

The `prod` stage preserves <https://triplex.build> and
<https://triplex-docs.bjacobso.workers.dev>. The `triplex.build` zone must be active
in the deploying Cloudflare account; Alchemy attaches the Worker's custom domain, and Cloudflare
manages its DNS record and HTTPS certificate. Only `prod` attaches the custom domain.

`.github/workflows/deploy.yml` deploys the exact `main` commit from a successful push run of CI,
after verification, package-consumer checks, documentation browser tests, PostgreSQL integration,
and stress smoke tests pass. Production deployments are serialized and are not canceled mid-deploy.

`.github/workflows/preview.yml` deploys same-repository pull requests on opening, updates, and
reopening to `pr-<number>`. Each stage has its own `triplex-docs-pr-<number>` Worker, serves a
`workers.dev` URL, and updates one sticky PR comment. Closing a PR destroys that stage and marks
the comment as removed. Deploy and cleanup share a per-PR concurrency group and finish before
another operation starts. Fork pull requests never receive deployments or credentials.

Configure these repository Actions secrets for both production and previews:

- `CLOUDFLARE_ACCOUNT_ID`: the account containing the production Worker and state store.
- `CLOUDFLARE_API_TOKEN`: a dedicated deployment token scoped to that account and the
  `triplex.build` zone. It needs account-level Workers Scripts Edit, Account Settings Read,
  and Secrets Store Edit, plus zone-level Zone Read and Workers Routes Edit. Its scope must
  allow creating and deleting preview Workers as well as updating the production Worker.

The preview workflow requests `pull-requests: write` for its sticky comment; repository or
organization Actions policies must allow that permission. Both workflows skip with an Actions
notice when credentials are absent, including cleanup; restore credentials and rerun the closed-PR
workflow if cleanup was skipped.

Both workflows use the existing remote `Cloudflare.state()` store. The `triplex` stack keeps its
`prod` state and isolates preview state by stage. Secrets Store Edit is required to bind the
state-store secret when a fresh runner authenticates; Secrets Store Read alone is insufficient.
See [Cloudflare's Secrets Store permissions](https://developers.cloudflare.com/secrets-store/access-control/).

Alchemy beta.84 discovers the provider through `@alchemy.run/cloudflare`. State-store maintenance
now uses `pnpm exec alchemy state bootstrap --backend cloudflare`; the old
`alchemy provider cloudflare bootstrap` command exits with a migration hint. Deployment commands pass `--yes`
so CI can provision or upgrade the existing state store when required.

## Verify a canary

Install from the registry in a clean directory outside this monorepo:

```sh
npm install @triplex-build/triplex@next effect @effect/sql-sqlite-node \
  @effect/platform-node @effect/platform-node-shared
npx triplex --help
npx triplex --sqlite ./canary.sqlite describe
npx triplex mcp --sqlite ./canary.sqlite
# In another terminal, verify the local dashboard:
npx triplex dashboard --sqlite ./canary.sqlite --port 4174
```

Also execute a small Effect program that asserts and queries a fact through SQLite. Confirm the
installed core contains only documented `dist` exports, there is one Effect runtime, and npm shows
provenance for the single canary package.

## Stable release

Every public API change must include a Changeset. On pushes to `main`, the release workflow either
updates a version PR or publishes the already-versioned package:

1. Review the generated versions, changelogs, lockfile changes, and single publishable package in the release PR.
2. Require a green CI run, including PostgreSQL and the packed external-consumer test.
3. Merge the release PR.
4. Approve the `npm-publish` environment deployment.
5. Verify the `latest` dist-tag, provenance, package contents, Git tags, and GitHub releases.

`pnpm release:version`, `pnpm release:publish`, and `pnpm release:canary` are the corresponding
low-level commands. The stable commands are intentionally separated so the version changes are
reviewed before publication.

If a bad release is published, prefer a corrected patch and an npm deprecation notice. Do not
unpublish a package version except where npm's security guidance requires it.
