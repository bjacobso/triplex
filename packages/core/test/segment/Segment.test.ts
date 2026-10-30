import { describe, expect, it } from "vitest";
import * as CanonicalJson from "../../src/content/CanonicalJson.js";
import * as ContentIds from "../../src/content/ContentId.js";
import * as Segment from "../../src/segment/Segment.js";
import type { TripleInput } from "../../src/Triple.js";
import type { TripleValue } from "../../src/Value.js";

const fact = (
  entityId: string,
  attribute: string,
  value: TripleValue,
  extra: Partial<TripleInput> = {},
): TripleInput => ({ entityId: entityId as TripleInput["entityId"], attribute, value, ...extra });

let seed = 11;
const random = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
const pick = <A>(items: readonly A[]): A => items[Math.floor(random() * items.length)]!;

const values: readonly TripleValue[] = [
  { type: "string", value: "a" },
  { type: "string", value: "b\u0000c" },
  { type: "string", value: "ünïcode" },
  { type: "number", value: 1 },
  { type: "number", value: -2.5 },
  { type: "boolean", value: true },
  { type: "boolean", value: false },
  { type: "datetime", value: 1_700_000_000_000 },
  { type: "ref", value: "e:1" as never },
  { type: "ref", value: "e:2" as never },
  { type: "json", value: { b: 1, a: [1, "x"] } },
  { type: "blob", value: "sha256:abc", mimeType: "text/plain", size: 3 },
];

const randomFacts = (count: number): TripleInput[] =>
  Array.from({ length: count }, () =>
    fact(pick(["e:1", "e:2", "e:3", "e:10"]), pick([":a/x", ":a/y", ":b/z"]), pick(values), {
      ...(random() < 0.7 ? { validFrom: Math.floor(random() * 100) } : {}),
      ...(random() < 0.3 ? { validTo: 100 + Math.floor(random() * 100) } : {}),
      ...(random() < 0.5 ? { entityType: pick(["Worker", "Site"]) } : {}),
      ...(random() < 0.5 ? { createdBy: pick(["alice", "bob"]) } : {}),
    }),
  );

const same = (a: TripleValue, b: TripleValue) =>
  CanonicalJson.encodeOrThrow(a as never) === CanonicalJson.encodeOrThrow(b as never);

describe("Segment", () => {
  it("is identified by its content, not its input order", () => {
    const facts = randomFacts(200);
    const forward = Segment.build(facts);
    const backward = Segment.build([...facts].reverse());
    expect(forward.id).toBe(backward.id);
    expect(ContentIds.isContentId(forward.id)).toBe(true);
    expect(Segment.verify(forward)).toBe(true);

    const changed = Segment.build([...facts.slice(1), { ...facts[0]!, validTo: 999 }]);
    expect(changed.id).not.toBe(forward.id);
  });

  it("hashes the canonical JSON of its facts in segment order", () => {
    const segment = Segment.build(randomFacts(50));
    const content = Array.from({ length: segment.count }, (_, i) => {
      const value = Segment.valueAt(segment, i);
      const string = (index: number) => (index < 0 ? null : segment.strings[index]!);
      const number = (n: number) => (Number.isNaN(n) ? null : n);
      return [
        segment.strings[segment.entity[i]!]!,
        segment.strings[segment.attribute[i]!]!,
        value as never,
        number(segment.validFrom[i]!),
        number(segment.validTo[i]!),
        string(segment.entityType[i]!),
        string(segment.createdBy[i]!),
      ];
    });
    expect(segment.id).toBe(
      ContentIds.hash(ContentIds.Domain.segment, CanonicalJson.encodeOrThrow(content)),
    );
  });

  it("keeps every fact, sorted by entity, attribute and value", () => {
    const facts = randomFacts(300);
    const segment = Segment.build(facts);
    expect(segment.count).toBe(300);
    for (let i = 1; i < segment.count; i++) {
      const previous = segment.strings[segment.entity[i - 1]!]!;
      const current = segment.strings[segment.entity[i]!]!;
      expect(previous <= current).toBe(true);
    }
    const key = (f: TripleInput) =>
      JSON.stringify([f.entityId, f.attribute, CanonicalJson.encodeOrThrow(f.value as never)]);
    const fromSegment = Array.from({ length: segment.count }, (_, i) =>
      key(
        fact(
          segment.strings[segment.entity[i]!]!,
          segment.strings[segment.attribute[i]!]!,
          Segment.valueAt(segment, i),
        ),
      ),
    ).sort();
    expect(fromSegment).toEqual(facts.map(key).sort());
  });

  it("finds facts by every access path", () => {
    const facts = randomFacts(400);
    const segment = Segment.build(facts);
    const patterns: Segment.Pattern[] = [
      { entity: "e:2" },
      { entity: "e:2", attribute: ":a/y" },
      { attribute: ":b/z" },
      ...values.map((value) => ({ attribute: ":a/x", value })),
      { value: { type: "ref", value: "e:1" as never } },
      { entityType: "Site" },
      { entity: "missing" },
      { attribute: ":missing/x" },
      {},
    ];
    for (const pattern of patterns) {
      const found = [...Segment.lookup(segment, pattern)]
        .filter((i) => {
          const value = Segment.valueAt(segment, i);
          return (
            (pattern.entity === undefined ||
              segment.strings[segment.entity[i]!] === pattern.entity) &&
            (pattern.attribute === undefined ||
              segment.strings[segment.attribute[i]!] === pattern.attribute) &&
            (pattern.value === undefined || same(value, pattern.value)) &&
            (pattern.entityType === undefined ||
              segment.strings[segment.entityType[i]!] === pattern.entityType)
          );
        })
        .map(
          (i) => `${segment.strings[segment.entity[i]!]} ${segment.strings[segment.attribute[i]!]}`,
        )
        .sort();
      const expected = facts
        .filter(
          (f) =>
            (pattern.entity === undefined || f.entityId === pattern.entity) &&
            (pattern.attribute === undefined || f.attribute === pattern.attribute) &&
            (pattern.value === undefined || same(f.value, pattern.value)) &&
            (pattern.entityType === undefined || f.entityType === pattern.entityType),
        )
        .map((f) => `${f.entityId} ${f.attribute}`)
        .sort();
      expect(found, JSON.stringify(pattern)).toEqual(expected);
    }
  });

  it("round-trips through its binary image without re-sorting", () => {
    const segment = Segment.build(randomFacts(250));
    const bytes = Segment.encode(segment);
    const decoded = Segment.decode(bytes, { verify: true });
    expect(decoded.id).toBe(segment.id);
    expect(decoded.count).toBe(segment.count);
    expect([...decoded.byAttributeValue]).toEqual([...segment.byAttributeValue]);
    expect(Array.from({ length: decoded.count }, (_, i) => Segment.valueAt(decoded, i))).toEqual(
      Array.from({ length: segment.count }, (_, i) => Segment.valueAt(segment, i)),
    );
    // Decoding views the bytes in place.
    expect(decoded.entity.buffer).toBe(bytes.buffer);

    // Columns are views, so changing one changes the image.
    const tampered = bytes.slice();
    const view = Segment.decode(tampered);
    view.validTo[0] = 123_456;
    expect(Segment.verify(view)).toBe(false);
    expect(() => Segment.decode(tampered, { verify: true })).toThrow(Segment.SegmentDecodeError);
    expect(() => Segment.decode(new Uint8Array(40))).toThrow(Segment.SegmentDecodeError);
  });

  it("builds an empty segment", () => {
    const segment = Segment.build([]);
    expect(segment.count).toBe(0);
    expect(Segment.lookup(segment, {})).toHaveLength(0);
    expect(Segment.decode(Segment.encode(segment)).id).toBe(segment.id);
  });
});
