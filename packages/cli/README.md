# Triplex CLI

An agent-friendly Effect CLI for inspecting and operating Triplex databases. It is built with the
Effect v4 `Command`, `Flag`, and `Argument` modules and emits stable JSON envelopes instead of
terminal-oriented tables.

```sh
pnpm turbo run build --filter=@triplex-build/triplex-cli...
triplex() { node --disable-warning=ExperimentalWarning packages/cli/dist/cli.js "$@"; }
triplex --sqlite ./app.db describe
triplex --sqlite ./app.db status
triplex --sqlite ./app.db entity types
```

Install `@triplex-build/triplex-cli` from npm to use the `triplex` binary. The repository command
above runs the same CLI from a source checkout. The unscoped
`triplex` package name on npm belongs to an unrelated project.

## Agent contract

- Successful commands write one `{ "ok": true, "command": "...", "data": ... }` JSON value to
  stdout.
- Failures write `{ "ok": false, "command": ..., "error": Diagnostic }` to stderr and exit nonzero.
- `describe` returns a machine-readable capability manifest and release schema; `--help` returns Effect CLI help.
- JSON payloads come from `--input <file>` or stdin with `--input -`.
- External entity, triple, transaction, database, query, value, and transaction-operation values
  are decoded by the same Effect schemas as the public Triplex API.
- Mutations through `transaction apply` require `meta.actor` and `meta.commandId` so agent writes
  are attributed and safely retryable.
- `error.code` is stable; `message` explains the failure, `path` locates input, and `fix` suggests recovery. `retryable` is always present. Reload facts before retrying a retryable conflict; use the journal receipt for duplicate command IDs.
- Input failures have `cli.arguments`, `cli.input-read`, `cli.input-json`, or `cli.input-schema` codes. Core failures retain their diagnostic codes.
- Add `--debug` to include a top-level `cause` string for debugging; it may contain input or storage details.
- Output is compact by default. Add `--pretty` before the subcommand for readable JSON.

## Discover the write schema

```sh
triplex --sqlite ./app.db describe
triplex --sqlite ./app.db describe --ref preview
```

`data.commands` retains the command manifest. `data.schema` describes the immutable release at
`live` by default, or the ref selected with `--ref`:

- `release`: `id`, `label`, `rootContentId`, and the requested `ref`.
- `entityTypes`: sorted `{ name, attributes }` entries. Each attribute has `key`, `valueType`
  (the full TypeExpr, including enum `values`), `required`, `cardinality`, `unique`,
  `referenceTarget` (a type name or `null`), and `sensitive`.
- `attributes`: every `{ key, valueType }` in the release, including unused attributes.
- `constraints`: enforced graph constraint `{ key, kind }` entries.
- `derivations`: `{ kind, key }` entries for derivations and other configuration objects.
- `examples`: one `{ entityType, input }` entry per type, with a `transaction apply` input.
- `rules`: five plain-string reminders about command atomicity, deterministic IDs, pinning and
  enforcement, valid intervals, and ending a value without erasing its past.

Examples assert every required attribute and carry `entityType` on every fact. For a type with
only optional attributes, the example asserts its first attribute so that the entity exists.
Replace synthetic IDs, `"<text>"`, actor, and command ID placeholders with application values.
Numbers start at `0`, booleans at `false`, dates at `"2000-01-01"`, instants at epoch `0`, and enums
use their first member. Reference placeholders such as `"<entity-id of Site>"` must name an
existing target valid at the example's commit time. Choose fresh values for unique attributes.
Examples include both `meta.configSnapshot` and `meta.enforce` from the described release; submit
`input` to `transaction apply --input <file>` after substitution. Pin that release for the whole
command, even if its ref moves later.

When the selected ref has no release, `data.schema` is `null` and `data.hint` explains how to publish
one using application-owned `config.commit`, or move an existing release with `config set-ref`.
`describe` opens the selected database and uses the same migration behavior as other data commands.

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
    "correlationId": "course:data-systems-201"
  }
}
JSON
```

Retrying a committed `commandId` returns Triplex's typed duplicate-command failure rather than
silently applying the write twice. Inspect the durable receipt with:

```sh
triplex --sqlite ./app.db journal receipt curriculum/create-mina/v1
```

## Inspect configuration

```sh
triplex --sqlite ./app.db config refs
triplex --sqlite ./app.db config releases
triplex --sqlite ./app.db config release --ref live
triplex --sqlite ./app.db config objects --kind form
triplex --sqlite ./app.db config object form quiz/bitemporal-facts
triplex --sqlite ./app.db config impact attribute :submission/status
SNAPSHOT_ID='copy an actual snapshotId returned by config releases'
triplex --sqlite ./app.db config set-ref live "$SNAPSHOT_ID"
```

Object inspection returns every immutable revision with its canonical body, parent revision,
content ID, closure ID, schema stamps, dependencies, and release membership. Release inspection
returns the pinned revision set and release ancestry. `set-ref` is the only configuration mutation
currently exposed; authoring typed nodes remains application-owned rather than accepting untyped
configuration JSON.

## Explain and preview

```sh
triplex --sqlite ./app.db why fact 01ARZ3NDEKTSV4RRFFQ69G5FAV
triplex --sqlite ./app.db why attribute worker:maria :worker/name
triplex --sqlite ./app.db why entity worker:maria --recorded-position 12 --valid-at 1788998400000
triplex --sqlite ./app.db why entity worker:maria --causation-depth 3
triplex --sqlite ./app.db why candidate --input candidate.json
triplex --sqlite ./app.db transaction preview --input command.json
triplex --sqlite ./app.db transaction apply --input command.json
```

Stored `why` subjects accept `--valid-at`, either `--recorded-at` or `--recorded-position`, and
`--causation-depth` (0–32). Fact explanations retain the retracting transaction; historical
entity and attribute explanations use the selected recorded cut.

Candidate JSON uses `{ subject: { kind: "candidate", definition, candidateId, revision },
basis: { validAt, recordedPosition }, causationDepth? }`. Supply the full immutable definition
returned by `Derivation.make` and the candidate's ID and revision; an explicit valid and recorded
basis is required. Candidate flags override JSON options. MCP exposes the same `WhyInput` schema.

Preview uses apply's input, including `meta.actor` and `meta.commandId`, and returns `release`,
`operations` (`ops`, `preconditions`), `changes`, `violations` and an empty `derivations` list.
Preserve `meta.configSnapshot` and `meta.enforce` from describe. Enforcement comes from the
supplied rules, exactly as for apply; the pin alone does not enforce constraints. An existing
command ID returns `commandAlreadyCommitted` and empty operations and changes.

Preview writes no facts, journal entries or receipts. It does not check preconditions, run commit
validators or reserve state. Apply checks current state again. Assertion IDs and commit metadata
are assigned at commit; omitted `validFrom` is evaluated again at commit, so pin it for exact
interval comparisons. Both capabilities use the normal JSON envelope and Diagnostic failures,
and redact sealed values without opening them.
