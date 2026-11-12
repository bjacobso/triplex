---
"@triplex-build/triplex": minor
---

Make attribute-use modifiers immutable and chainable in any order while preserving literal
cardinality and requiredness. Chained and options declarations produce identical configuration
content IDs, including sensitive attribute definitions.

Breaking: `Attribute.Use.required` and `Attribute.Use.unique` are now methods. Read the data
from `isRequired` and `isUnique` instead. `cardinality`, `UseOptions`, and entity-handle data
fields are unchanged. Modifiers on definitions still accept options; subsequent use modifiers
are zero-argument calls that preserve the other constraints.
