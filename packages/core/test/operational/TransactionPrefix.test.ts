import { describe, expect, it } from "vitest";
import { transactionPrefixBounds } from "../../src/store/transactionPrefix.js";

const encoder = new TextEncoder();
const compare = (a: string, b: string) => {
  const left = encoder.encode(a),
    right = encoder.encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++)
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  return left.length - right.length;
};

describe("UTF-8 transaction prefix bounds", () => {
  it("matches startsWith including partial surrogate pairs and maximum code points", () => {
    const values = [
      "",
      "home:a",
      "HOME:a",
      "home:%_x",
      "home:éx",
      "home:😀x",
      "home:😁",
      "home:\u{10ffff}x",
      "\0x",
      "a\0z",
      "\ud7ff",
      "\ue000",
      "\u{10ffff}\u{10ffff}",
    ];
    const prefixes = [
      ...new Set(
        values.flatMap((value) =>
          Array.from({ length: value.length + 1 }, (_, i) => value.slice(0, i)),
        ),
      ),
      "\udc00",
      "\ud800x",
    ];
    for (const prefix of prefixes)
      for (const value of values) {
        const bounds = transactionPrefixBounds(prefix);
        const matches =
          bounds !== null &&
          compare(value, bounds.lower) >= 0 &&
          (bounds.upper === undefined || compare(value, bounds.upper) < 0);
        expect(matches, `${JSON.stringify(value)} startsWith ${JSON.stringify(prefix)}`).toBe(
          value.startsWith(prefix),
        );
      }
  });
});
