# Getting started

Start with the [Database client](/database) from `@triplex-build/triplex/database`. This guide
declares entity types, publishes a release, opens the client, and runs one command, a typed read,
a Schema-projected query and a historical read.

::: warning Pre-1.0 packages
The `@triplex-build` packages are available from npm and require `effect@4.1.1`.
Effect 3 is incompatible. Do not use the superseded `@bjacobso` package names for new work.
:::

## Prerequisites

- Git
- Node.js 22.19.0 or newer
- Corepack and pnpm 10.11.0 (the repository declares the exact package-manager version)

For an application, install the published core package and its Effect peer dependency:

```sh
npm install @triplex-build/triplex effect@4.1.1
```

## Run the schema-bound client example

Clone the repository and install its locked dependencies:

```sh
git clone https://github.com/bjacobso/triplex.git
cd triplex
corepack enable
pnpm install --frozen-lockfile
```

Run the checked quickstart directly from the checkout:

```sh
pnpm exec tsx --tsconfig docs/snippets/tsconfig.json docs/snippets/client-getting-started.ts
```

The complete program is:

<<< @/snippets/client-getting-started.ts{ts}

It prints:

```json
{
  "person": { "name": "Alice", "employer": "company:acme" },
  "relationships": [{ "?person": "Alice", "?company": "Acme" }],
  "knownThen": { "name": "Alice", "employer": "company:acme" }
}
```

### What the Effect code is doing

1. `EntityType` declares aliases, attribute types, required fields and reference targets.
2. `ConfigStore.commit` publishes the model as an immutable release and moves `live` to it.
3. `Database.layer` checks the published model before providing the `Database.Database` service.
4. `db.command` requires actor and command ID, pins and enforces the release, and commits the
   builder's Effects atomically. Retrying the same ID returns the persisted receipt.
5. `db.get` uses `Type.decode` to return alias-keyed typed values. `db.query` checks attributes
   against the release and decodes each binding with the supplied Effect Schema.
6. `db.asOf` captures a stable read-only view. The receipt's exact position selects what was
   known at that command; `validAt` selects business time.

`Effect.gen` sequences Effects with generator syntax. `Effect.provide` supplies services and
`Effect.runPromise` runs the fully provided program. Publishing precedes client acquisition and
both share one `Store`. Real hosts generally publish during deployment.

Create and share layers at the application boundary. A new `KvTriples.layer` runtime owns a fresh
in-memory database, whose contents disappear when that runtime/process ends. The query returns one
bounded page (100 rows by default); follow `nextCursor` for more. Client command callbacks should
contain database work, with external delivery handled by the host.

## Raw Triples quick start

Use the primitive service when building host infrastructure or exploring facts without a model.
This second program writes raw facts and runs a Datalog join:

<<< @/snippets/getting-started.ts{ts}

Run it with `pnpm exec tsx --tsconfig docs/snippets/tsconfig.json docs/snippets/getting-started.ts`.
It prints a `relationships` array containing `{ "person": "Alice", "company": "Acme" }`.
Raw `Triples` does not automatically pin/enforce a release, check attribute spelling, decode an
entity, or recover retry receipts. Prefer the client for application commands and reads; see
[Underneath the client](/agents#underneath-the-client) for the explicit primitive contracts.

## Use durable SQLite

SQLite is the supported local persistent backend. Install it alongside core and Effect:

```sh
npm install @triplex-build/triplex/sqlite
```

In the first program, import `SqliteTriples` from `@triplex-build/triplex/sqlite` and replace
`KvTriples.layer` inside `Store` with `SqliteTriples.layer({ filename: "./triplex.db" })`.
Keep `ConfigStore.layer` over that same store and provide the client after publishing. On a
persistent database, issue a new command ID only for a new domain command; rerunning the example
with its original ID returns the original receipt.

The convenience layer opens the file and applies Triplex's current migration. Construct it once
for the application lifetime. Hosts that separate schema migration from runtime startup should use
the explicit composition in [Host integration](/host-integration).

## Use Triplex from a source checkout

To try unreleased changes from a checkout in a project outside the repository workspace, build the
packages and link their built output. Package exports point to generated `dist` files, so an
unbuilt checkout cannot be imported. Build the packages you need and their dependencies:

```sh
cd triplex
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@triplex-build/triplex/sqlite...
```

Then link them into your project. Link Effect from the copy core resolves too, so your code and
Triplex share one Effect instance; two copies make service tags disagree:

```sh
cd ../my-project
mkdir -p node_modules/@triplex-build
ln -sfn "$PWD/../triplex/packages/core" node_modules/@triplex-build/triplex
ln -sfn "$PWD/../triplex/packages/sqlite" node_modules/@triplex-build/triplex/sqlite
ln -sfn "$PWD/../triplex/packages/core/node_modules/effect" node_modules/effect
```

Rebuild after changing the checkout. For a copy that installs like the published packages, run
`pnpm pack` in each package directory and install the tarballs with `effect@4.1.1` instead.

Don't use `docs/snippets/tsconfig.json` for an outside project. It maps the package names to
`packages/*/src` so the documentation can type-check against unbuilt sources, which bypasses the
public exports your application will use.

## Next steps

- Read [Database client](/database) for commands, typed reads, projections and historical views.
- Experiment without installing anything in the browser [Playground](/playground).
- Read [Core concepts](/concepts) before modeling a domain with historical facts.
- Follow [Configuration releases and rollback](/configuration-versioning) to version rules and pin
  operational writes to them.
- Learn query clauses and pagination in [Datalog](/datalog).
- Explore a database through the [CLI and dashboard](/tools).
- Check the [current maturity contract](/current-state) before choosing a production backend.
