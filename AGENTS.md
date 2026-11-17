# Working on Triplex

Triplex is a pre-1.0, Effect-native fact database for TypeScript. Read
[CONTRIBUTING.md](CONTRIBUTING.md), [ARCHITECTURE.md](ARCHITECTURE.md), and
[Current state](docs/current-state.md) before changing its contracts. The
[modeling guide](docs/agents.md) covers building applications with Triplex.

## Setup and checks

Use Node.js 22.19.0 or newer and the pinned pnpm 10.11.0:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` is the single root check: formatting (oxfmt), linting (oxlint),
TypeScript, checked Markdown examples and generated example outputs, unit and
SQLite/workerd integration tests, package builds, and the VitePress docs build.
The docs build also checks the generated `dist/llms.txt` structure and local links.

Run `pnpm pack:check` after package changes to verify tarballs and a clean consumer.
PostgreSQL and FoundationDB integrations require external services or native
libraries and are opt-in with `pnpm test:postgres:integration` and
`pnpm test:foundationdb:integration`. Follow CONTRIBUTING.md for changes that
require these suites. Browser tests use `pnpm test:e2e` after installing Chromium
with `pnpm exec playwright install chromium`. Stress tests are opt-in with
`pnpm --filter triplex-stress stress-test`.

## Repository layout

- `packages/core`: browser-safe model, Effect services, KV storage, Datalog,
  configuration, derivations, and public runtime composition.
- `packages/sql`, `packages/sqlite`, `packages/postgres`, `packages/cloudflare`,
  `packages/foundationdb`: shared SQL and backend implementations.
- `packages/host`, `packages/http`, `packages/cli`, `packages/dashboard`,
  `packages/testkit`: hosting contracts, HTTP, tools, and reusable conformance tests.
- `examples/`: runnable demos and reference hosts.
- `test/integration`, `test/stress`, `e2e/`: cross-package, stress, and browser tests.
- `docs/`: VitePress pages and checked snippets; `docs/.vitepress/llms.ts`
  generates `llms.txt`, `llms-full.txt`, and Markdown page variants into `dist/`.
- `scripts/`: documentation and package checks.
- `.github/workflows/`: CI, docs deployment, and Changesets releases;
  `alchemy.run.ts` defines the Cloudflare documentation site.

## Conventions and boundaries

- Use ESM and TypeScript with Effect. Pin external dependencies in the root pnpm
  catalog and use workspace packages through their public exports.
- Preserve the one-way graph in ARCHITECTURE.md: core must not depend on backends
  or Node-only APIs; SQL and backend packages build on core.
- Public exports point to generated `dist` files. Add a Changeset for a
  publishable package change; keep private packages out of its frontmatter.
- Mark self-contained documentation examples with `ts check` fences; use ordinary
  `ts` fences for fragments. Keep generated outputs in sync with `pnpm docs:outputs`.
- Keep maturity claims accurate: KV and SQLite are supported, PostgreSQL is a
  pre-1.0 production candidate, and Cloudflare and FoundationDB are experimental.
- Do not edit generated `dist` files, import sibling project source, or bypass
  public package boundaries. Do not deploy manually, publish packages, or merge
  without explicit authorization; the existing workflows handle deployment and
  releases.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
