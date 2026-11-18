# Canonical JSON and content IDs

Triplex gives every configuration node, release, derivation candidate, decision and pagination
cursor a **content ID**. A content ID is a SHA-256 hash of a deterministic JSON encoding of a
value. The encoder and the hash are public, from `@triplex-build/triplex/content`. A host that
needs the same byte-for-byte encoding, for its own hashes or to compare its values with Triplex's,
can import them instead of writing its own encoder.

```ts check
import { CanonicalJson, ContentId } from "@triplex-build/triplex/content";
import { Effect } from "effect";

// Throws CanonicalEncodingError on a value it cannot encode.
const text = CanonicalJson.encodeOrThrow({ z: -0, a: [undefined, 1] });
// text === '{"a":[null,1],"z":0}'

// The Effect form fails with CanonicalEncodingError instead of throwing.
const encoded: Effect.Effect<string, CanonicalJson.CanonicalEncodingError> = CanonicalJson.encode({
  name: "Ada",
  roles: ["admin"],
});

// A content ID is "sha256-" plus 64 hex digits, hashed within a domain.
const id: ContentId.ContentId = ContentId.hash("my-app/profile", text);
```

## The encoding contract

The contract is **byte identity**: two values that mean the same JSON value encode to the same
bytes, on any machine and in any process. `JSON.stringify` does not promise that, because it keeps
insertion order. The encoder follows these rules.

| Input                                                 | Encoding                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Object keys                                           | Sorted in ascending UTF-16 code-unit order (JavaScript `<` on strings)               |
| An object property whose value is `undefined`         | Omitted, as if absent                                                                |
| `undefined` or a hole in an array                     | `null`; the array's length is part of the value                                      |
| Numbers                                               | `JSON.stringify`'s shortest round-trip form; `-0` becomes `0`, and `1.0` becomes `1` |
| Strings                                               | `JSON.stringify` escaping; no Unicode normalization                                  |
| `NaN`, `Infinity`, `-Infinity`                        | Rejected (`non_finite_number`)                                                       |
| `Date`, `BigInt`, functions, symbols, class instances | Rejected (`unsupported_type`)                                                        |
| A cycle                                               | Rejected (`circular_reference`)                                                      |

No whitespace is emitted. A rejection is a `CanonicalEncodingError` with a `reason` and a dotted
`path` to the offending value, for example `attrs.rule.conditions[2]`.

What it deliberately does not do:

- **It is not RFC 8785 (JCS).** It agrees with JCS on key order and on number formatting, but its
  conformance has not been checked, so do not rely on byte equality with another JCS
  implementation.
- **It does not normalize Unicode.** `"é"` written as one code point and as `e` plus a combining
  accent are different strings and hash differently. Normalize before encoding if your inputs can
  differ that way.
- **It does not guess at dates or class instances.** A timestamp in a hash would change the hash
  when nothing else did, so project values to plain objects, strings and numbers first. The error
  message asks for exactly that.

## Content IDs and domains

`ContentId.hash(domain, payload)` computes `sha256-<hex>` over `<domain length>:<domain>:<payload>`.
The length-prefixed domain keeps two kinds of value from ever sharing a pre-image: a configuration
node and a decision with the same JSON body still get different IDs. Use your own domain names
(`my-app/profile`), not Triplex's (`ContentId.Domain` lists them, all under `triplex/`).

`ContentId.isContentId` and `ContentId.ContentIdSchema` check the `sha256-` plus 64 lowercase hex
shape. `ContentId.short(id)` gives 12 hex digits for logs and UI; never compare short IDs.
`Sha256.hex` is the plain hash, available everywhere Triplex runs, including browsers.

## Moving an existing encoder onto this one

If a host already hashes with its own canonical JSON, it can switch without changing any stored
hash, provided the bytes match:

1. Encode a sample of real values with both encoders and compare the strings, not the hashes.
   Include the edge cases in the table above: `-0`, `undefined` in arrays and objects, non-ASCII
   keys, and very large and very small numbers.
2. If every sample matches, replace the host encoder with `CanonicalJson.encodeOrThrow` or
   `CanonicalJson.encode`. Existing hashes stay valid.
3. If any differ, the existing hashes depend on the old encoding. Either keep the old encoder for
   those hashes, or re-hash and record the change, for example under a new domain name so old and
   new IDs cannot be confused.
