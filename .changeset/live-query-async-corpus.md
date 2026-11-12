---
"@triplex-build/triplex": patch
---

Drive the live-query coalescing case's test clock until its pull completes so asynchronous backends can finish reading the head before scheduling the coalescing delay. Keep the existing coverage and result assertions unchanged.
