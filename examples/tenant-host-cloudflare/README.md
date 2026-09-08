# Cloudflare isolated-tenant host

This private reference application deploys one gateway Worker with two Durable Object classes:

- `TenantRegistryObject` is the singleton, durable CAS registry and lifecycle control plane.
- `TenantDatabase` maps one immutable `(environment, tenantId, databaseId, generation)` identity
  to one SQLite Durable Object database and one scoped Triplex runtime per activation.

The data route is `POST /v1/data`. It never creates unknown tenants. A tenant bearer token is
resolved to a principal, the registry must contain an exact `ready` identity/routing revision, and
the target object verifies the internal capability, bound identity, revision, lifecycle state, and
principal again. Request, transaction, and Datalog-clause limits are enforced before execution.

Admin routes are `POST /v1/admin/provision`, `/v1/admin/suspend`, `/v1/admin/resume`, and
`/v1/admin/delete`.
Provision requests require stable `generation` and `operationId` values so retries after an unknown
outcome address the same operation. Deletion fences the route and leaves a tombstone; this example
retains database contents for operator-managed purge rather than silently deleting them.

## Configure and run

Set these deployment-only environment variables (do not commit them):

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
export TRIPLEX_HOST_ADMIN_TOKEN=...
export TRIPLEX_HOST_INTERNAL_CAPABILITY=...
export TRIPLEX_HOST_TENANT_TOKENS='{"tenant-a":"...","tenant-b":"..."}'
```

Then use the pinned Alchemy v2 stack:

```bash
pnpm --filter triplex-tenant-host-cloudflare plan
pnpm --filter triplex-tenant-host-cloudflare deploy
pnpm --filter triplex-tenant-host-cloudflare dev
```

The stack is deliberately separate from the documentation stack and uses the state identity
`triplex-tenant-host`. Its Worker removal policy is `retain`, protecting Durable Object namespaces
from accidental stack removal. Review and explicitly change that policy before intentional
teardown. A second unchanged apply should plan as a no-op; code updates retain object identities
and tenant data.

The default test runs the two-tenant host inside workerd. It covers authorization and direct actor
fencing, per-object data/feed isolation, cursor scoping, provisioning retries and concurrency,
storage persistence after an activation abort, suspension, deletion, and generation-safe
recreation.

Status: reference implementation. Credentialed plan/apply/no-op, upgrade, retention, and
provider-failure tests remain opt-in and are not part of `pnpm check`.
