---
"@triplex-build/triplex": minor
---

Expose `recordedPosition` on the shared temporal read basis for entity, batch,
match, Datalog, and paginated reads. Position zero is the empty cut; positions
must be non-negative safe integers. Supplying both `recordedAt` and
`recordedPosition` is rejected. Valid-time behavior is unchanged.
Position reads also hide later retraction metadata so the returned facts match
their earlier state; full audit/history reads retain the stored metadata.

Pages bind the explicit position into their cursor and preserve it across later
commits. Future positions are capped at the head for paging; omit the basis on
continuation to reuse that captured cut. Position-only pages do not add a
wall-clock filter. `EntityPageSnapshot.recordedAt` is consequently optional for
these new requests, a pre-1.0 source-level change; existing timestamp/default
requests still return it. Persisted derivations retain the position basis and
include it in freshness and journal fallback checks.

SQL migration v4 adds `idx_entity_recorded_position` on entity ID and recorded
position. Run the existing `runMigrations` entrypoint before acquiring host-owned
unmigrated layers. Standalone migrating layers apply it automatically. Cloudflare
uses migration v5 (experimental); KV needs no migration. The testkit now checks
generated assertion/retraction/replacement histories against captured commit cuts
on every read surface.
