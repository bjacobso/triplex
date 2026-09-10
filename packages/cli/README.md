# Triplex CLI

An agent-friendly Effect CLI for inspecting and operating Triplex databases. It is built with the
Effect v4 `Command`, `Flag`, and `Argument` modules and emits stable JSON envelopes instead of
terminal-oriented tables.

```sh
pnpm --silent triplex --sqlite ./app.db describe
pnpm --silent triplex --sqlite ./app.db status
pnpm --silent triplex --sqlite ./app.db entity types
```

The same commands are available through the `triplex` binary installed by the current canary:

```sh
pnpm add @bjacobso/triplex-cli@next
```

Or run it without installing:

```sh
npx @bjacobso/triplex-cli@next db create app
```

The unscoped `triplex` name on npm belongs to an unrelated project, so the package spec must remain
scoped when using `npx`. Once installed, the binary itself is simply `triplex`.

## Agent contract

- Successful commands write one `{ "ok": true, "command": "...", "data": ... }` JSON value to
  stdout.
- Runtime and schema failures write `{ "ok": false, "error": ... }` to stderr and exit nonzero.
- `describe` returns a machine-readable capability manifest; `--help` returns Effect CLI help.
- JSON payloads come from `--input <file>` or stdin with `--input -`.
- External entity, triple, transaction, database, query, value, and transaction-operation values
  are decoded by the same Effect schemas as the public Triplex API.
- Mutations through `transaction apply` require `meta.actor` and `meta.commandId` so agent writes
  are attributed and safely retryable.
- Output is compact by default. Add `--pretty` before the subcommand for readable JSON.

## Databases

Create and manage isolated SQLite databases in `./data` (or a directory selected with
`--data-dir`):

```sh
triplex db create app --description "Application database"
triplex db list
triplex db get app
triplex db update app --description "Primary application database"
triplex db clear app --yes
triplex db delete app --yes
```

Use a managed database for the other commands by selecting its ID:

```sh
triplex --database-id app status
triplex --database-id app entity list
```

SQLite is the default backend:

```sh
triplex --sqlite ./app.db status
```

Use a PostgreSQL URL directly, preferably through the environment so credentials do not enter shell
history:

```sh
TRIPLEX_POSTGRES_URL='postgresql://user:password@localhost/app' \
  triplex status
```

For schema-isolated logical databases, supply a validated database ID resolved by trusted host code:

```sh
TRIPLEX_POSTGRES_URL='postgresql://user:password@localhost/app' \
  triplex --database-id organization-a status
```

The CLI uses the migrated convenience layers. Opening a database may apply pending Triplex
migrations; production hosts that require migration separation should run migrations through their
deployment process before granting CLI access.

## Explore entities and facts

```sh
triplex --sqlite ./app.db entity types
triplex --sqlite ./app.db entity list --type Student --limit 50
triplex --sqlite ./app.db entity get student:mina
triplex --sqlite ./app.db entity facts student:mina
triplex --sqlite ./app.db entity history student:mina --limit 25
```

`entity history` returns `snapshotPosition` and `nextBeforePosition`. Pass both into the next command
to retain stable newest-first pagination while concurrent commits occur.

Low-level fact matching accepts a public `QueryRequest`:

```sh
printf '%s' '{"entityType":"Student","attribute":":person/name"}' |
  triplex --sqlite ./app.db fact match --input -
```

Current reads accept `--valid-at` and `--recorded-at` epoch-millisecond flags.

## Run Datalog

```sh
triplex --sqlite ./app.db query run --input query.json --debug
triplex --sqlite ./app.db query explain --input query.json
```

For example, `query.json` can contain:

```json
{
  "find": ["?student", "?name"],
  "where": [["?student", ":person/name", "?name"]],
  "orderBy": [{ "variable": "?name", "direction": "asc" }]
}
```

Use `query page` with a public `WrappedQuery` payload for snapshot-stable opaque cursor pagination.

## Write facts

`transaction apply` accepts the public `TransactRequest` schema. Assertions and retractions commit
with one causal journal envelope:

```sh
triplex --sqlite ./app.db transaction apply --input - <<'JSON'
{
  "operations": [
    {
      "op": "assert",
      "entityId": "student:mina",
      "entityType": "Student",
      "attribute": ":person/name",
      "value": { "type": "string", "value": "Mina Patel" }
    }
  ],
  "meta": {
    "actor": "agent:curriculum",
    "commandId": "curriculum/create-mina/v1",
    "correlationId": "course:data-systems-201",
    "configSnapshot": "sha256-..."
  }
}
JSON
```

Retrying a committed `commandId` returns Triplex's typed duplicate-command failure rather than
silently applying the write twice. Inspect the durable receipt with:

```sh
triplex --sqlite ./app.db journal receipt curriculum/create-mina/v1
```

## Splunk configuration

```sh
triplex --sqlite ./app.db config refs
triplex --sqlite ./app.db config releases
triplex --sqlite ./app.db config release --ref live
triplex --sqlite ./app.db config objects --kind form
triplex --sqlite ./app.db config object form quiz/bitemporal-facts
triplex --sqlite ./app.db config impact attribute :submission/status
triplex --sqlite ./app.db config set-ref live sha256-...
```

Object inspection returns every immutable revision with its canonical body, parent revision,
content ID, closure ID, schema stamps, dependencies, and release membership. Release inspection
returns the pinned revision set and release ancestry. `set-ref` is the only configuration mutation
currently exposed; authoring typed nodes remains application-owned rather than accepting untyped
configuration JSON.
