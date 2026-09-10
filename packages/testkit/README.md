# @triplex-build/triplex-testkit

Reusable backend fixture and capability helpers for testing Triplex adapters.

The `@triplex-build` packages are not yet published. Evaluate this workspace package from a source
checkout with the repository's locked Node.js, pnpm, and Effect versions.

`triplesConformanceCases` and `makeTriplesConformanceSuite` define the behavioral contract used by
the in-memory KV, SQLite, and opt-in PostgreSQL suites. The corpus covers atomic writes, typed
values, temporal reads, Datalog semantics, stable pagination, the transaction journal, command
receipts, checkpoints, derivations, and graph constraints. New backends should pass it before being
described as supported.

MIT © 2026 Ben Jacobson.
