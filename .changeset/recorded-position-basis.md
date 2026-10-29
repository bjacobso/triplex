---
"@triplex-build/triplex": minor
"@triplex-build/triplex-testkit": minor
---

Accept `recordedPosition` in the public temporal basis. A read at a commit position sees exactly the
transactions committed at or before it, even when commits share a millisecond. Paged Datalog and
entity pages clamp it to the latest commit, and derivation runs persist it.
