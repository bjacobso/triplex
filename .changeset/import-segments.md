---
"@triplex-build/triplex": minor
---

Add experimental import segments to `@triplex-build/triplex/operational`. `Segment.build` sorts
and indexes a batch of facts in one pass into an immutable, content-addressed segment;
`Segment.encode` and `decode` move it as one buffer; `Segment.attach` adds it to an in-memory KV
store in one transaction that journals a single summary. Reads merge attached segments with
indexed facts at any basis, retracting a segment fact is ordinary history, and
`Import.run(..., { store: "segments" })` builds and attaches one segment per chunk before
publishing a `PositionRef`. `Sha256.create` adds an incremental hasher, and SHA-256 is about
2.7 times faster.
