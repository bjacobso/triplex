---
"@triplex-build/triplex": minor
---

Preserve `recordedPosition` when forwarding tenant-protocol `Query` and `QueryPage`
options to Triples. Historical requests now retain their exact commit cut after
later assertions/retractions, including empty position zero and page continuation.
Requests supplying both recorded timestamp and position now reach core validation
and are rejected consistently. HTTP entity and collection reads now expose and validate `recordedPosition` as a
non-negative safe integer, retain it through cursor continuation, and reject it
on writes. Generated OpenAPI includes the parameter. Dashboard fact-read helpers
and entity pages preserve the same position, cap future page cuts at the initial
head, and continue accepting existing timestamp cursors. No new migration is
required.
