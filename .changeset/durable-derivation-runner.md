---
"@triplex-build/triplex": minor
---

Add the browser-safe `/runner` subpath for durable derivation diff handlers, acknowledged candidate
snapshots, Outbox recovery, bounded retries, scoped supervision and offline temporal boundary replay.
Publish the ordinary runner control schema, runner conformance helpers and a compliance host using
schema-bound commands. Add `KvTriples.layerWithClock` for deterministic commit/runner clock wiring.

Consumer checkpoints now read unretracted facts and write `validFrom: 0`, preserving durable
progress when the wall clock rolls backwards.
