---
title: Backend blueprints
description: Explore how SQLite, FoundationDB, Datomic, and XTDB primitives can support a Triplex storage layer, with implementation paths and explicit maturity labels.
pageClass: backend-blueprint
---

<p class="blueprint-eyebrow">Storage / Backend blueprints</p>

# Your database. Triplex's memory.

<p class="blueprint-lead">Build on the storage primitives you already trust. Keep facts, time, versioned rules, and derived work behind one TypeScript API.</p>

Triplex separates its application model from storage and query execution. These blueprints show
how a backend can provide that foundation: the data representation, the transaction boundary,
the query path, and the checks an implementation needs to pass.

<div class="blueprint-cards">
<a href="/sqlite">
<span class="blueprint-status">Supported</span>
<span><strong>SQLite</strong></span>
<span>A working reference for durable, embedded storage. Follow the rows, indexes, and SQL transaction.</span>
<span class="blueprint-card-link">Explore SQLite →</span>
</a>
<a href="/foundationdb">
<span class="blueprint-status">Experimental</span>
<span><strong>FoundationDB</strong></span>
<span>Ordered keys and distributed transactions underneath Triplex's existing hexastore engine.</span>
<span class="blueprint-card-link">Explore FoundationDB →</span>
</a>
<a href="/datomic">
<span class="blueprint-status">Proposed blueprint</span>
<span><strong>Datomic</strong></span>
<span>Assertion entities, immutable database values, and a design for bridging the transaction models.</span>
<span class="blueprint-card-link">Explore Datomic →</span>
</a>
<a href="/xtdb">
<span class="blueprint-status">Proposed blueprint</span>
<span><strong>XTDB</strong></span>
<span>A temporal SQL backend, with explicit fact identity and an atomic command submission design.</span>
<span class="blueprint-card-link">Explore XTDB →</span>
</a>
</div>

**Supported** means the backend is in Triplex's baseline behavioral test boundary.
**Experimental** means an implementation exists but has outstanding operational gates.
**Proposed blueprint** means a design to investigate; no adapter or installable integration exists.
The [current state](/current-state#backend-maturity) remains the maturity contract for implemented
backends, including PostgreSQL and Cloudflare.

## One application model, two implementation paths

| Your backend supplies                                                  | Composition path | You implement                        | Triplex supplies                                         |
| ---------------------------------------------------------------------- | ---------------- | ------------------------------------ | -------------------------------------------------------- |
| Ordered byte keys, bounded range scans, atomic read/write transactions | `Runtime.fromKv` | `KvBackend`                          | Hexastore storage and Datalog execution                  |
| Fact-oriented or relational storage with its own execution model       | `Runtime.define` | `StorageAdapter` and `QueryExecutor` | The public `Triples` service and higher-level primitives |

Both paths must preserve atomic facts and journal writes, ordered commit positions, unique command
receipts, bitemporal reads, and snapshot-stable query pages. Sharing a query language or a temporal
vocabulary alone does not establish those guarantees.

Configuration releases, decision proofs, and derivations use Triplex's existing services on top of
that contract. Your application still owns authorization, workflow effects, timer delivery, and
the meaning of reconciled work. [Host integration](/host-integration) describes that boundary.

## The same correction should mean the same thing

Use the [homepage's checked scenario](/#one-scenario) as the first design exercise. Maria's training
was recorded as valid from March 1 until June 1. An auditor later corrects its start date to March 5.

Every backend must retain the original assertion, record its retraction, and create a new assertion
in one command. A March 3 query using the earlier recorded basis must still show training. The
same query using current knowledge must show the gap. The placement's receipt must still point
to the configuration release that governed it, and an already-open query cursor must retain its
original results even after the correction.

## Build a backend

1. Choose an isolated physical database or keyspace and bind a `DatabaseScope` to it. Scope is
   cursor identity; physical partitioning and authorization are separate host responsibilities.
2. Implement the base storage and query contract with `Capabilities.none`. Establish rollback,
   duplicate-command behavior, typed values, history, and pinned pages before adding projections.
3. Run `runtimeConformance` from `@triplex-build/triplex/testkit` against a fresh isolated database.
   Add backend-specific concurrency, interruption, crash, and migration exercises.
4. Add durable snapshot or change-emission providers explicitly if your deployment needs them.
   Measure their failure behavior separately from source transaction correctness.

The [custom runtime guide](/custom-runtimes) contains checked composition examples and the full
adapter contract. Passing the shared corpus establishes behavioral compatibility within its
coverage; production durability and operational readiness need additional evidence.

Have a backend in mind? [Open a design issue](https://github.com/bjacobso/triplex/issues/new) with
its transaction model, proposed fact representation, and a plan for preserving this correction.
Start with a small conformance-backed implementation, then extend it.
