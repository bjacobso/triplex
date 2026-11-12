---
"@triplex-build/triplex": patch
---

Resolve database client recorded-time views through the indexed recorded-basis read instead of paging the transaction journal. Preserve exact commit cuts for timestamp ties, future timestamps, and later writes.
