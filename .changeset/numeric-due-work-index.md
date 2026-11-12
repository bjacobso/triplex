---
"@triplex-build/triplex": patch
---

Provision a shared numeric/datetime expression index through an additive SQL migration, enabling
Datalog range scans for live and snapshot-pinned actor due-work queries without application DDL.
Preserve numeric comparison semantics and add shared backend conformance coverage for due-work
ordering, limits, temporal visibility, and continuation after retraction. Existing SQL databases
must apply migration v2; creating the index scans existing numeric history and can block writes.
