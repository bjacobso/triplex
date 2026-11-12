---
"@triplex-build/triplex": patch
---

Guarantee assertion order in transaction receipts and submitted operation order in journal changes
on every backend. Persist change indices in journal JSON facts and read older records by metadata
fact ID without a schema migration. Pattern retractions expand in ascending triple-ID order.
This changes previously unspecified, backend-dependent journal ordering; callers that relied on
storage scan order must use submitted operation order instead.
