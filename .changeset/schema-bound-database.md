---
"@triplex-build/triplex": minor
---

Add the `@triplex-build/triplex/database` subpath with a schema-bound Effect service,
release compatibility checks, pinned and enforced commands, guarded entity reads,
idempotent receipt recovery, typed bounded reads and queries, and stable asOf views.

`Attribute.ref` now retains its runtime target declaration and `EntityType.nodesOf`
includes transitive reference targets, deduplicated by CID. Existing individual node
CIDs are unchanged. The resulting nodesOf array can contain additional referenced
declarations; callers publishing only a partial graph now publish its target closure.
No existing method is removed, and the root export is unchanged.
