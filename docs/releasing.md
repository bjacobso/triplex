# Releasing Triplex

Triplex uses Changesets for one coordinated package-family release. Publishing is performed by
GitHub Actions; routine releases should not depend on a maintainer's local npm configuration.

## Release set

The first public release contains:

- `@bjacobso/triplex`
- `@bjacobso/triplex-sql`
- `@bjacobso/triplex-sqlite`
- `@bjacobso/triplex-postgres`
- `@bjacobso/triplex-testkit`
- `@bjacobso/triplex-cli`

`@bjacobso/triplex-cloudflare` and `@bjacobso/triplex-foundationdb` remain private workspace
packages until they pass the supported backend conformance contract. The dashboard and examples
are also private.

The public package manifests start at `0.0.0`. The initial minor Changeset advances every package
in the release set to `0.1.0`, produces its changelog, and keeps the first published versions
aligned.

## Required repository configuration

Create a GitHub environment named `npm-publish` and require maintainer approval for it. Protect
`main` with the Node 22, Node 24, package-consumer, and PostgreSQL integration jobs from CI.
Repository Actions settings must allow GitHub Actions to create pull requests so the version job
can maintain the release PR.

The release workflow uses npm trusted publishing. For each public package, configure this trusted
publisher after the package exists:

| Field       | Value         |
| ----------- | ------------- |
| Owner       | `bjacobso`    |
| Repository  | `triplex`     |
| Workflow    | `release.yml` |
| Environment | `npm-publish` |

Allow direct `npm publish` for this workflow. It runs on a GitHub-hosted runner with
`id-token: write`; npm therefore issues a short-lived OIDC credential and records provenance.

## One-time npm bootstrap (completed)

npm package settings do not exist until the package has first been created. The package family was
bootstrapped with an authenticated local canary, then all six trusted publishers were registered
and verified by a second GitHub Actions OIDC canary. No long-lived npm token is required by the
current workflow.

For a new package added to the family, repeat the minimal bootstrap sequence:

1. Authenticate as the npm owner of the `@bjacobso` scope and confirm the new name is available.
2. Create a granular token limited to the new package with publish access and the minimum useful
   lifetime.
3. Store it as the `NPM_TOKEN` secret on the protected `npm-publish` GitHub environment.
4. Manually dispatch the **Release** workflow. The canary job publishes snapshot versions under
   the `next` dist-tag and does not create or push Git tags.
5. Configure the trusted publisher above for every package.
6. Delete `NPM_TOKEN`, revoke the bootstrap token, and leave OIDC as the only automation
   credential.

Do not put an npm token in the repository, a shell command, or a checked-in `.npmrc`.

npm assigned the first bootstrap snapshot to both `latest` and `next` and rejects deleting the
package's only `latest` tag. Until stable `0.1.0` replaces it, documentation and consumer checks
must always install `@next` explicitly.

## Documentation deployment

The VitePress site is deployed to Cloudflare as an assets-only Worker with the Effect-native
Alchemy stack in `alchemy.run.ts`. Preview the infrastructure diff before applying it:

```sh
pnpm docs:plan
pnpm docs:deploy
```

The production stage publishes <https://triplex.build>, with
<https://triplex-docs.bjacobso.workers.dev> also available. The `triplex.build` zone must be active
in the deploying Cloudflare account; Alchemy attaches the Worker's custom domain, and Cloudflare
manages its DNS record and HTTPS certificate. Only the `prod` stage attaches the custom domain.
Local deployment uses the maintainer's authenticated Alchemy profile.

The CI workflow deploys documentation after every push to `main` (including PR merges), once
verification, package-consumer checks, documentation browser tests, and PostgreSQL integration
tests pass. Pull requests do not deploy. Production deployments are serialized and are not
canceled mid-deploy.

Configure these repository Actions secrets before the first CI deployment:

- `CLOUDFLARE_ACCOUNT_ID`: the same account used by the local production deployment.
- `CLOUDFLARE_API_TOKEN`: a dedicated deployment token scoped to that account and the
  `triplex.build` zone. It needs account-level Workers Scripts Edit, Account Settings Read,
  and Secrets Store Edit, plus zone-level Zone Read and Workers Routes Edit.

CI uses Alchemy's existing remote `Cloudflare.state()` store, so local and automated deployments
share the `triplex` stack's `prod` state. Secrets Store Edit is required to bind the state-store
secret when a fresh runner authenticates; Secrets Store Read alone is insufficient. See
[Cloudflare's Secrets Store permissions](https://developers.cloudflare.com/secrets-store/access-control/).

## Verify the canary

Install from the registry in a clean directory outside this monorepo:

```sh
pnpm init
pnpm add effect@4.0.0-rc.112 \
  @bjacobso/triplex@next \
  @bjacobso/triplex-sqlite@next \
  @bjacobso/triplex-cli@next
pnpm exec triplex --help
pnpm exec triplex --sqlite ./canary.sqlite describe
```

Also execute a small Effect program that asserts and queries a fact through SQLite. Confirm the
installed core contains only documented `dist` exports, there is one Effect runtime, and npm shows
provenance for every canary package.

## Stable release

Every public API change must include a Changeset. On pushes to `main`, the release workflow either
updates a version PR or publishes the already-versioned packages:

1. Review the generated versions, changelogs, lockfile changes, and package set in the release PR.
2. Require a green CI run, including PostgreSQL and the packed external-consumer test.
3. Merge the release PR.
4. Approve the `npm-publish` environment deployment.
5. Verify the `latest` dist-tags, provenance, package contents, Git tags, and GitHub releases.

`pnpm release:version`, `pnpm release:publish`, and `pnpm release:canary` are the corresponding
low-level commands. The stable commands are intentionally separated so the version changes are
reviewed before publication.

If a bad release is published, prefer a corrected patch and an npm deprecation notice. Do not
unpublish a package version except where npm's security guidance requires it.
