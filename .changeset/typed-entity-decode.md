---
"@triplex-build/triplex": minor
---

Add Effect-native `EntityType.decode` to materialize visible facts by declaration alias,
validate stored types and requiredness, reject ambiguous scalar facts and mixed subjects or
types, and keep sealed values as safe markers. Optional metadata preserves source facts for
temporal edits. Instants decode to epoch-millisecond numbers; many values deduplicate and
sort by canonical identity.

`Attribute.Use` now carries a third generic parameter for literal requiredness. Concise
modifiers and `Attribute.use` retain that flag, and bare definitions remain optional. Existing
two-parameter annotations remain broad; no existing runtime shape is removed. Decoded sealable
values include a `SealedMarker` union because stored sealed values stay sealed even after a
sensitivity declaration changes. Breaking change: `decode` is now a reserved entity attribute alias, so declarations that
previously used that alias must rename it. No existing helper is removed.
