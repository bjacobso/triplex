---
"@triplex-build/triplex": minor
---

Add indexed `Triples.resolveRecordedBasis` and `Triples.dependencyStateAll` reads.
Resolve recorded timestamps to exact captured commit cuts, including tied instants,
and read wildcard freshness and valid-time schedules without loading fact payloads.

Breaking adapter contract: custom Triples services must implement both reads, and
StorageAdapter implementations must add `recordedPositionAt` and `dependencyStateAll`.
Apply SQL migration v9 before using these reads with host-owned schemas. Existing KV
stores build the new read indexes once on opening. Service decorators that spread the
inner service pass both methods through unchanged.
