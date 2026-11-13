---
"@triplex-build/triplex": minor
---

Sensitive values gain key classes and a key custody contract. `Attribute.sensitive(definition, { keyClass })`
names the key class of an attribute (such as `retention-7y`), recorded on its attribute node; a subject's
values in different key classes are sealed under different data keys, so one class can be erased while
another is kept. `KeyContext` and `SensitiveContext` now carry `keyClass` (`default` when none is declared).
The new `KeyCustody` service destroys a subject's data keys, for one key class or all, returning the
destroyed key IDs, and rotates data keys for a database, subject or key class. `KeyProvider.testKeys`
now returns `{ provider, custody, layer }` instead of `destroy` and `rotate` functions, and its key IDs name
their scope. The AES-GCM envelope is now version 2: its authenticated data also binds the key class and the
key ID, so a ciphertext cannot be relabelled with another key. Version 1 envelopes no longer open; they were
only ever sealed with test keys.
