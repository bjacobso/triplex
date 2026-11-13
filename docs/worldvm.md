# Triplex and WorldVM

Triplex is a standalone database. It has no dependency on WorldVM, and you do not need WorldVM to
use it. It is also the temporal fact store in [WorldVM](https://worldvm.com), a TypeScript runtime
and standard library for software that models the world, reasons about it, and acts on it.

This page describes that relationship and the contract between the two projects. WorldVM's
`@worldvm/*` packages are not published yet; anything here that names them describes planned work.

## What does not change

- Triplex keeps its name, the `@triplex-build` npm scope, its MIT license, and this site.
- The [maturity contract](/current-state) belongs to Triplex. Using Triplex through WorldVM adds
  no guarantee beyond it: a WorldVM deployment is only as durable as the Triplex backend it runs on.
- Triplex's public API has no WorldVM-specific surface. When WorldVM needs something from storage,
  it lands here as a general, backend-neutral Triplex feature with its own documentation and
  conformance tests. The [numeric range index](/datalog-performance#numeric-ranges-and-actor-due-work)
  began as a Runfold due-work query and shipped as an ordinary Datalog improvement.

## The question Triplex answers

WorldVM divides a system into concepts that each answer one question. Triplex answers one of them:
**what is true, and what was true?**

| Concept       | Question                          | Relationship to Triplex                                                      |
| ------------- | --------------------------------- | ---------------------------------------------------------------------------- |
| Open Ontology | What exists?                      | A separate project; its runtime adapter stores and queries models in Triplex |
| Triplex       | What is/was true?                 | Bitemporal facts, the causal journal, and versioned configuration            |
| Query         | What do I know?                   | A WorldVM concept; Triplex Datalog evaluates queries over facts              |
| Program       | What could happen?                | A WorldVM concept; its engine stores definitions and run facts in Triplex    |
| Change        | What would change?                | A WorldVM concept; Triplex overlays preview hypothetical facts               |
| Policy        | What is allowed?                  | A WorldVM concept; Triplex records which release governed a write            |
| Thread        | What is happening?                | A WorldVM concept                                                            |
| Event         | What happened?                    | A WorldVM concept; the Triplex journal records every commit                  |
| Connection    | How do I reach the outside world? | A WorldVM concept                                                            |

WorldVM is what makes those concepts one system. Within it:

- **Open Ontology** is WorldVM's world model.
- **Triplex** is WorldVM's temporal fact store.
- **Runfold** is the engine that runs WorldVM programs. Developers use the planned
  `@worldvm/program` package; Runfold is the interpreter underneath it, not a separate product.

## The boundary

To Triplex, WorldVM is a host application. The responsibility split in
[Core concepts](/concepts#constraints-and-responsibility-boundaries) and
[Host integration](/host-integration) applies unchanged: Triplex records and explains state; the
host decides who may act, what work to do, and how to reach the outside world.

### What WorldVM relies on

WorldVM uses only Triplex's public entrypoints. This is the surface its runtime builds on:

| Area       | Triplex surface                                                                                                    | What WorldVM uses it for                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Facts      | `Triples.transact`, `entity`, `match`, `history`; `EntityId`, `ref`, and typed values                              | Storing entities, facts, and relations as attributed assertions       |
| Time       | The `{ recordedAt, validAt }` read basis, `validFrom`/`validTo`, `currentPosition`                                 | As-of reads, future-effective facts, and expiring evidence            |
| Query      | `query`, `queryPage`, `queryAll`                                                                                   | Evaluating fact queries at one coherent basis                         |
| Journal    | `transactions`, `transactionsForEntity`, `transactionByCommand`, `ConsumerCheckpoint`                              | Command receipts, safe retries, entity timelines, and worker catch-up |
| Config     | `ConfigStore` (`commit`, `resolveRef`, `snapshotById`), `Attribute`, `EntityType`, `GraphConstraint`               | Publishing versioned definitions and enforcing them atomically        |
| Provenance | Transaction `meta`: `actor`, `commandId`, `correlationId`, `causationId`, `configSnapshot`, `enforce`; `ContentId` | Recording who acted, under which release, and in response to what     |
| Storage    | `KvTriples`, `SqliteTriples`, `PgTriples.layerFromSqlClient`, and the `runtime` subpath                            | Choosing a backend and sharing a host SQL transaction                 |

Changes to this surface follow Triplex's normal release process and changesets. Nothing on it is
reserved for WorldVM.

### What WorldVM owns

- **Actors and capabilities.** Triplex records the `actor` a host supplies; it does not
  authenticate anyone or decide who may act.
- **Programs, threads, and timers.** A derivation reports its next temporal boundary; WorldVM
  schedules the wakeup, runs the work, and retries it.
- **Events.** The Triplex journal records commits. Domain events such as `member.invited` are
  WorldVM vocabulary, recorded through those commits.
- **Connections and external effects.** Triplex never sends an email, calls a webhook, or charges a
  card.
- **Standard library types.** Organization, User, Membership, Subscription, and similar types are
  WorldVM types stored as Triplex facts. Triplex has no built-in notion of them.

### Ground rules

- WorldVM imports public entrypoints only, never `@triplex-build/triplex/internal`.
- `_triplex/*` entities and `:triplex/*` attributes stay reserved for Triplex. WorldVM uses its own
  namespaces.
- A WorldVM need that Triplex's public API cannot meet becomes a Triplex proposal, specified
  without reference to WorldVM and tested on every supported backend.
