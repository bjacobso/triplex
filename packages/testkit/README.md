# @triplex-build/triplex-testkit

Reusable backend fixture and capability helpers for testing Triplex adapters.

```bash
npm install --save-dev effect@4.0.0-rc.112 @triplex-build/triplex-testkit@next
```

`triplesConformanceCases` and `makeTriplesConformanceSuite` define the behavioral contract used by
the in-memory KV, SQLite, and opt-in PostgreSQL suites. The corpus covers atomic writes, typed
values, temporal reads, Datalog semantics, stable pagination, the transaction journal, command
receipts, checkpoints, derivations, and graph constraints. New backends should pass it before being
described as supported.

Pre-1.0 canaries are published under the `next` tag.

MIT © 2026 Ben Jacobson.
