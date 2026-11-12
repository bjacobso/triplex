# MCP server

`@triplex-build/triplex/mcp` is a **private, experimental** workspace package. It exposes one
Triplex database per process through MCP over stdio, using Effect's MCP server. Build it from a
source checkout; it is not published to npm:

```sh
pnpm turbo run build --filter=@triplex-build/triplex/mcp...
node packages/mcp/dist/bin.js --sqlite /absolute/path/to/app.db
```

Register it with an MCP client using the client's server configuration. Replace both absolute
paths with your checkout and database locations:

```json
{
  "mcpServers": {
    "triplex": {
      "command": "node",
      "args": [
        "/absolute/path/to/triplex/packages/mcp/dist/bin.js",
        "--sqlite",
        "/absolute/path/to/app.db"
      ]
    }
  }
}
```

The built package also defines a `triplex-mcp` binary. The client must support MCP protocol
version `2025-11-25`. Stdout carries only MCP messages; startup diagnostics go to stderr.

Backend flags follow the [CLI](/tools): `--sqlite <file>` defaults to `./triplex.sqlite`;
`--postgres-url <url>` selects PostgreSQL (or use the `TRIPLEX_POSTGRES_URL` environment variable).
`--database-id <id>` selects a managed PostgreSQL database or `./data/<id>.db` for SQLite;
`--data-dir <directory>` changes that SQLite directory. Relative paths resolve from the server
process's working directory. Opening SQLite can apply pending migrations.

## Tools

Each tool advertises an Effect-derived input schema through `tools/list`. Inputs use the same
field names and wire values as the CLI's public `execute` operations, without the `_tag` field.

| Tool                  | Input                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------- |
| `describe`            | Optional `ref` (defaults to `live`)                                                     |
| `status`              | No parameters                                                                           |
| `entity_types`        | Optional `includeSystem` (defaults to `false`)                                          |
| `entity_get`          | `entityId`, optional `basis`                                                            |
| `entity_facts`        | `entityId`                                                                              |
| `entity_history`      | `entityId`, optional `limit`, `snapshotPosition`, `beforePosition`                      |
| `fact_match`          | `pattern`, optional `basis`                                                             |
| `query_run`           | `query`, optional `cursor`, `pageSize`, `basis`, `debug`                                |
| `query_page`          | Wrapped `query`, optional `basis`, `debug`                                              |
| `query_explain`       | `query`                                                                                 |
| `journal_list`        | Optional `after` (defaults to `0`), `limit`                                             |
| `journal_receipt`     | `commandId`                                                                             |
| `config_release`      | Optional `snapshotId` or `ref`                                                          |
| `why`                 | `subject` (fact, attribute, entity or candidate), optional `basis`, `causationDepth`    |
| `transaction_preview` | Same input as `transaction_apply`; no commit                                            |
| `transaction_apply`   | `operations`, required `meta.actor` and `meta.commandId`; optional transaction metadata |

History and journal limits default to 100 and accept 1–1,000. Query page sizes follow the same
bounds. A `basis` may specify `validAt` and either `recordedAt` or `recordedPosition`.

Start with `describe`. It reads the live immutable release, including schema, constraints, rules
and transaction examples. Substitute real values into an example's `input`, then pass that
object directly as `transaction_apply` arguments. Preserve `meta.configSnapshot` and `meta.enforce`
to apply the described constraints. Every write requires an actor and a unique command ID.
If the response is lost, call `journal_receipt` with the original ID before retrying.

Successful calls return the same JSON `data` as the CLI, in text content and `structuredContent`.
Runtime failures return `isError: true` with a JSON [Diagnostic](/errors) in text content: branch
on `code`, use `path` and `fix` when present, and honor `retryable`. Invalid parameters are rejected
by MCP schema validation before execution. Sealed values are redacted using the CLI's output
shaping; plaintext, ciphertext and blind tokens from sealed envelopes are never returned. Hosts
remain responsible for sealing sensitive writes with [Sensitive.layer](/sensitive-values) and for
database access permissions; the standalone server does not configure codec keys or authorization.

`why` returns the core [explanation DTO](/why). Candidate subjects include the full immutable
`Derivation.make` definition, `candidateId` and `revision`, with explicit recorded and valid basis.
Stored subjects identify a `tripleId`, an `entityId` and attribute, or an `entityId` alone.
`causationDepth` defaults to zero and accepts integers through 32.

Use `transaction_preview` before `transaction_apply` with the same command input and ID. Preview
returns projected operations, changes and new constraint violations under the supplied `meta.enforce`,
or `commandAlreadyCommitted` for an existing ID. It does not write, check preconditions, run commit
validators or reserve state. Preserve the release pin and enforcement from describe; a pin alone
does not enforce constraints. See [CLI preview](/tools#explain-and-preview) for result fields and
clock behavior.

HTTP transport is planned; this first cut serves stdio only.
