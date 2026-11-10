/** UTF-8 ordered bounds with JavaScript's literal UTF-16 startsWith semantics. */
const successor = (value: string): string | undefined => {
  const points = Array.from(value);
  while (points.length > 0) {
    const last = points.pop()!.codePointAt(0)!;
    if (last < 0x10ffff) {
      const next = last + 1 === 0xd800 ? 0xe000 : last + 1;
      return points.join("") + String.fromCodePoint(next);
    }
  }
  return undefined;
};

export const transactionPrefixBounds = (
  prefix: string,
): { readonly lower: string; readonly upper?: string } | null => {
  let lower = prefix;
  let upper: string | undefined;
  for (let i = 0; i < prefix.length; i++) {
    const unit = prefix.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (i === prefix.length - 1) {
        // A trailing high surrogate matches all astral characters in its block.
        const base = prefix.slice(0, i);
        const first = 0x10000 + (unit - 0xd800) * 0x400;
        lower = base + String.fromCodePoint(first);
        upper =
          first + 0x400 <= 0x10ffff ? base + String.fromCodePoint(first + 0x400) : successor(base);
        return { lower, ...(upper === undefined ? {} : { upper }) };
      }
      const low = prefix.charCodeAt(++i);
      if (low < 0xdc00 || low > 0xdfff) return null;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return null;
  }
  upper = successor(prefix);
  return { lower, ...(upper === undefined ? {} : { upper }) };
};
