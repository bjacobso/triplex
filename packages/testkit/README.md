# @triplex-build/triplex-testkit

Reusable backend fixture and capability helpers for testing Triplex adapters.

Install `@triplex-build/triplex-testkit` from npm with Node.js 22+ and the compatible Effect 4
release candidate.

`triplesConformanceCases` and `makeTriplesConformanceSuite` define the behavioral contract used by
the in-memory KV, SQLite, and opt-in PostgreSQL suites. The corpus covers atomic writes, typed
values, temporal reads, Datalog semantics, stable pagination, the transaction journal, command
receipts, checkpoints, derivations, and graph constraints. New backends should pass it before being
described as supported.

`runtimeConformance(definition, options)` builds a public `Runtime.define` or `Runtime.fromKv`
definition and runs that same corpus. Use a fresh isolated backend and choose capabilities
explicitly. This is a Triples contract check, not a guarantee of snapshot/emitter correctness,
crash durability, cross-process isolation, or migration safety.

MIT © 2026 Ben Jacobson.
