---
"@triplex-build/triplex-host": patch
---

Preserve `recordedPosition` when forwarding tenant-protocol `Query` and `QueryPage`
options to Triples. Historical requests now retain their exact commit cut after
later assertions/retractions, including empty position zero and page continuation.
Requests supplying both recorded timestamp and position now reach core validation
and are rejected consistently. No new migration is required.
