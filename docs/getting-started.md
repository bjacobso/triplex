# Getting started

This guide writes three facts to an in-memory Triplex database, joins them with Datalog, and prints
the result. It is the shortest complete path to a running program.

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

## Run the example

Clone the repository and install its locked dependencies:

```sh
git clone https://github.com/bjacobso/triplex.git
cd triplex
corepack enable
pnpm install --frozen-lockfile
```

Run the checked quickstart directly from the checkout:

```sh
pnpm exec tsx --tsconfig docs/snippets/tsconfig.json docs/snippets/getting-started.ts
```

The complete program is:

<<< @/snippets/getting-started.ts{ts}

It prints:

```json
{
  "relationships": [
    {
      "person": "Alice",
      "company": "Acme"
    }
  ]
}
```

The repository's smaller demo is another executable starting point:

```sh
pnpm exec tsx --tsconfig docs/snippets/tsconfig.json examples/demo/demo.ts
```

## What the Effect code is doing

You only need four Effect ideas for this example:

1. `Triples` is a service tag. `yield* Triples` asks the current Effect context for the database.
2. `Effect.gen` lets the program sequence database effects with generator syntax.
3. `KvTriples.layer` constructs the in-memory implementation of that service.
4. `Effect.provide` supplies the layer, and `Effect.runPromise` runs the fully provided program.

Create and share a layer at your application boundary. Do not construct a new layer inside each
request: each `KvTriples.layer` runtime owns a fresh in-memory database, and its contents disappear
when that runtime/process ends.

The transaction records three typed values atomically. `ref(acme)` is a relationship because its
value is another `EntityId`; the Datalog query follows that relationship by using the same
`?company` variable in two clauses. `query` returns one bounded page, which is enough for this
one-row example. Follow `nextCursor` for larger results or use `queryAll` only for trusted batch
work that intentionally needs the complete result set.

## Use durable SQLite

SQLite is the supported local persistent backend. Install it alongside core and Effect:

```sh
npm install @triplex-build/triplex-sqlite
```

Replace the in-memory layer with a file-backed layer:

```ts
import { SqliteTriples } from "@triplex-build/triplex-sqlite";

const DatabaseLive = SqliteTriples.layer({ filename: "./triplex.db" });
const relationships = await Effect.runPromise(program.pipe(Effect.provide(DatabaseLive)));
```

This is a focused replacement fragment: `program` is the complete program above. The convenience
layer opens the SQLite file and applies Triplex's current migration. Create it once and share it for
the application lifetime. Production hosts that separate schema migration from runtime startup
should use the explicit unmigrated composition described in [Host integration](/host-integration).

## Use Triplex from a source checkout

To try unreleased changes from a checkout in a project outside the repository workspace, build the
packages and link their built output. Package exports point to generated `dist` files, so an
unbuilt checkout cannot be imported. Build the packages you need and their dependencies:

```sh
cd triplex
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@triplex-build/triplex-sqlite...
```

Then link them into your project. Link Effect from the copy core resolves too, so your code and
Triplex share one Effect instance; two copies make service tags disagree:

```sh
cd ../my-project
mkdir -p node_modules/@triplex-build
ln -sfn "$PWD/../triplex/packages/core" node_modules/@triplex-build/triplex
ln -sfn "$PWD/../triplex/packages/sqlite" node_modules/@triplex-build/triplex-sqlite
ln -sfn "$PWD/../triplex/packages/core/node_modules/effect" node_modules/effect
```

Rebuild after changing the checkout. For a copy that installs like the published packages, run
`pnpm pack` in each package directory and install the tarballs with `effect@4.1.1` instead.

Don't use `docs/snippets/tsconfig.json` for an outside project. It maps the package names to
`packages/*/src` so the documentation can type-check against unbuilt sources, which bypasses the
public exports your application will use.

## Next steps

- Experiment without installing anything in the browser [Playground](/playground).
- Read [Core concepts](/concepts) before modeling a domain with historical facts.
- Follow [Configuration releases and rollback](/configuration-versioning) to version rules and pin
  operational writes to them.
- Learn query clauses and pagination in [Datalog](/datalog).
- Explore a database through the [CLI and dashboard](/tools).
- Check the [current maturity contract](/current-state) before choosing a production backend.
