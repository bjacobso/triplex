# Triplex HTTP API example

Start an ephemeral in-memory KV host:

```sh
pnpm --filter triplex-http-api-example start
```

Or persist through SQLite:

```sh
pnpm --filter triplex-http-api-example start --sqlite ./triplex.sqlite
```

The host uses Effect CLI for argument validation and help:

```sh
pnpm example:http-api --help
pnpm example:http-api --sqlite ./triplex.sqlite --host 127.0.0.1 --port 3001
```

The defaults are in-memory storage, host `127.0.0.1`, and port `3000`. Use `--port 0`
to allocate an available port. The example logs documentation URLs with the bound
address after configuration deployment and server startup succeed. Database and
HTTP resources share the Effect layer lifecycle and are closed on shutdown.

The example persists two configuration deployments and keeps both documentation versions mounted:

- `http://127.0.0.1:3000/api/rest/v1/docs` — `Employee` with only `:employee/name`
- `http://127.0.0.1:3000/api/rest/v2/docs` — adds optional `:employee/email`
- `http://127.0.0.1:3000/api/rest/latest/docs` — the v2 contract at the writable `live` ref

The immutable `v1` and `v2` aliases are read-only, so their OpenAPI documents show reads only.
`latest` demonstrates the same v2 schema with write operations enabled.

Create and read employees through the current deployment:

```sh
curl -i -X POST http://127.0.0.1:3000/api/rest/latest/employees \
  -H 'content-type: application/json' \
  --data '{"attributes":{":employee/name":"Ada",":employee/email":"ada@example.com"}}'
curl http://127.0.0.1:3000/api/rest/latest/employees
curl http://127.0.0.1:3000/api/rest/latest/openapi.json
```

To compare the raw contracts instead of the interactive UI:

```sh
curl http://127.0.0.1:3000/api/rest/v1/openapi.json
curl http://127.0.0.1:3000/api/rest/v2/openapi.json
```

## OpenAPI snapshots

The generated contracts are checked in as readable JSON:

- [v1](test/openapi/v1.json): name only, read-only.
- [v2](test/openapi/v2.json): name and email, read-only.
- [latest](test/openapi/latest.json): the v2 schema with CRUD enabled.

Tests request each OpenAPI endpoint through the same configuration deployment and
routes used by the server, with a fresh in-memory database and no listening socket.
They preserve the actual deterministic configuration IDs and use the repository's
JSON formatting. Missing or changed snapshots fail `pnpm check` without rewriting files.

After an intentional schema or generator change, regenerate and inspect the diff:

```sh
pnpm --filter triplex-http-api-example snapshots:update
git diff -- examples/http-api/test/openapi
```

Commit the updated JSON alongside the change. Git keeps the running history of each
contract; inspect it with:

```sh
git log -p -- examples/http-api/test/openapi/latest.json
```

To check just the example snapshots, run `pnpm --filter triplex-http-api-example test`.

This example deliberately installs the explicit allow-all authorization layer. Real hosts should
provide an application policy through `HttpAuthorization`.
