---
"@triplex-build/triplex": minor
---

Export `diagnose(error)` and `Diagnostic` for stable, JSON-serializable error codes,
input paths, recovery hints and retryability across public core errors. Datalog
validation errors now carry optional code, path and fix metadata at their raise
sites. Constraint details expose only keys, subjects and valid-time instants;
transaction conflicts distinguish precondition, serialization and deadlock causes.

No existing public shapes are removed. Error codes are a new public contract;
callers can branch on them instead of parsing free-text messages.
