# @bjacobso/triplex-host

Portable Effect contracts for hosting isolated Triplex databases. This package owns immutable
instance identity, authorization, lifecycle registry/provisioner contracts, route fencing, and the
versioned data protocol. It depends only on public `@bjacobso/triplex` APIs and Effect; providers
implement these contracts in their own packages or applications.

An instance identity includes environment, tenant, database, and generation. Gateways resolve a
`ready` registry record with `resolveAuthorizedPlacement`, then send the complete identity and
routing revision to the target. `executeTenantDataRequest` checks both again before authorizing and
accessing the bound `Triples` service. Unknown tenants never auto-provision through the data API.

The initial v1 protocol includes transactions, entity/triple reads, Datalog queries and pages,
receipt lookup, and journal polling. Raw SQL and provisioning are intentionally absent.

Status: private experimental workspace package.

MIT © 2026 Ben Jacobson.
