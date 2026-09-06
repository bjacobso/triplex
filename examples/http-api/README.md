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

This example deliberately installs the explicit allow-all authorization layer. Real hosts should
provide an application policy through `HttpAuthorization`.
