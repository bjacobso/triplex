# CLI and dashboard

Triplex includes two operator tools in the repository: a JSON-first CLI for repeatable commands and
a browser dashboard for interactive exploration. Both are pre-1.0. The CLI package is not yet
available under the new npm scope, and the dashboard is a private workspace package rather than a
published application.

## Build from the source checkout

After following [Getting started](/getting-started), build the CLI and its workspace dependencies,
then define a short shell function for the built binary:

```sh
pnpm turbo run build --filter=@triplex-build/triplex-cli...
triplex() { node --disable-warning=ExperimentalWarning packages/cli/dist/cli.js "$@"; }
```

The examples below use the repository command so they work before registry publication:

```sh
triplex --sqlite ./app.db describe
triplex --sqlite ./app.db status
```

`describe` returns the machine-readable command manifest. Successful CLI commands emit one
`{ "ok": true, "command": "…", "data": … }` JSON value to stdout. Decode/runtime failures emit an
error envelope to stderr and exit nonzero. Add `--pretty` before the subcommand when reading output
by hand.

Opening the SQLite convenience layer can apply pending Triplex migrations. Hosts that require
migration separation should run migrations in their deployment process before granting CLI access.

## Write and inspect a fact

`transaction apply` accepts the public `TransactRequest` wire shape. Mutation input must include an
actor and a unique command ID:

```sh
triplex --sqlite ./app.db transaction apply --input - <<'JSON'
{
  "operations": [
    {
      "op": "assert",
      "entityId": "worker:maria",
      "entityType": "Worker",
      "attribute": ":worker/name",
      "value": { "type": "string", "value": "Maria" }
    }
  ],
  "meta": {
    "actor": "user:docs",
    "commandId": "docs/create-maria/v1"
  }
}
JSON

triplex --sqlite ./app.db entity types
triplex --sqlite ./app.db entity get worker:maria
triplex --sqlite ./app.db entity facts worker:maria
triplex --sqlite ./app.db journal receipt docs/create-maria/v1
```

Do not retry that payload with a new command ID merely because the client lost the response. Look
up the original receipt first. A duplicate committed command ID produces
`CommandAlreadyCommittedError`; it does not silently execute or return success again.

## Run and page a query

Create `query.json`:

```json
{
  "find": ["?worker", "?name"],
  "where": [["?worker", ":worker/name", "?name"]],
  "orderBy": [{ "variable": "?name", "direction": "asc" }]
}
```

Run or explain it:

```sh
triplex --sqlite ./app.db query run --input query.json --limit 50 --debug
triplex --sqlite ./app.db query explain --input query.json
```

`query run` returns one bounded page. If `data.nextCursor` is present, pass that exact opaque value
back with `--cursor`; keep the query, page size, database, and temporal basis unchanged. The cursor
pins the recorded snapshot so concurrent writes do not reshuffle an in-progress scan.

Use epoch milliseconds to inspect a historical basis:

```sh
triplex --sqlite ./app.db entity get worker:maria \
  --recorded-at 1788998400000 --valid-at 1788998400000
```

The same `--recorded-at` and `--valid-at` flags are available for fact and query reads. See [Core
concepts](/concepts#recorded-time-and-valid-time) before interpreting a one-axis historical query.

## Inspect configuration

Configuration authoring remains application-owned. Once an application has committed releases,
operators can inspect and move their refs:

```sh
triplex --sqlite ./app.db config refs
triplex --sqlite ./app.db config releases
triplex --sqlite ./app.db config release --ref live
triplex --sqlite ./app.db config objects --kind entity-schema
triplex --sqlite ./app.db config object entity-schema Course
triplex --sqlite ./app.db config impact attribute :course/status
```

`config releases` returns the real snapshot IDs. To promote or roll back, copy the intended returned
ID and pass it unchanged:

```sh
SNAPSHOT_ID='copy an actual snapshotId returned above'
triplex --sqlite ./app.db config set-ref live "$SNAPSHOT_ID"
```

The assignment is an operator template, not a command to paste unchanged. Inspect the target
release before moving the ref. Moving it does not change operational data; see [Configuration
releases and rollback](/configuration-versioning#understand-rollback).

## Manage local databases

The CLI can manage isolated SQLite files in `./data` (or `--data-dir`):

```sh
triplex db create app --description "Application database"
triplex db list
triplex --database-id app status
```

`db clear` and `db delete` are destructive and require `--yes`. PostgreSQL can be selected with
`TRIPLEX_POSTGRES_URL`; prefer the environment over a URL flag so credentials do not enter shell
history. A host must resolve database IDs from authenticated server-owned state, not unchecked
request input.

## Explore in the dashboard

Start the browser-local demo:

```sh
pnpm dashboard
```

Open `http://localhost:4173`. The demo loads classroom fixtures into a fresh in-memory database.
Edits are real Triplex writes but disappear when the app runtime restarts.

To inspect a persistent database, build and run the local HTTP host:

```sh
pnpm dashboard:serve -- --sqlite /absolute/path/to/triplex.db
```

The dashboard includes entity tables and timelines, raw Datalog and query plans, the transaction
journal, derivation candidates, form previews, and full configuration release/ref/revision history.
Its footer selects recorded and valid time independently; configuration and journal views remain
current so the surrounding context stays visible.

The server binds to `127.0.0.1` and has mutation capabilities. It is an operator tool, not an
authenticated public server. Do not expose it as your application's authorization boundary.

## Runnable demos

- [`examples/demo`](https://github.com/bjacobso/triplex/tree/main/examples/demo) — linked facts and
  Datalog
- [`examples/compliance-host`](https://github.com/bjacobso/triplex/tree/main/examples/compliance-host)
  — configuration, journal catch-up, derivation reconciliation, overlays, and temporal wakeups
- [`examples/http-api`](https://github.com/bjacobso/triplex/tree/main/examples/http-api) — generated
  HTTP routes and OpenAPI
- [`examples/config-explorer`](https://github.com/bjacobso/triplex/tree/main/examples/config-explorer)
  — configuration graphs, diffs, evaluation, and proof tamper detection
- [`examples/tenant-host-cloudflare`](https://github.com/bjacobso/triplex/tree/main/examples/tenant-host-cloudflare)
  — experimental multi-tenant reference host

For the exhaustive CLI command contract, see the [package
README](https://github.com/bjacobso/triplex/tree/main/packages/cli). For common failures, continue to
[Troubleshooting and FAQ](/troubleshooting).
