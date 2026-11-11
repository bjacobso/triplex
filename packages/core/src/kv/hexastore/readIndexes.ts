import { Effect, Stream } from "effect";
import type { Datom } from "./KvTripleStore.js";
import type { KvBackendService, KvEntry } from "../kv/KvBackend.js";
import { concat, increment } from "../kv/encoding.js";
import { encodeTuple, tNumber, tString } from "./tuple.js";
import { ReadError } from "../../errors/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const READ_INDEX_READY = new Uint8Array([0x28]);
const DEPENDENCY = new Uint8Array([0x09]);
const JOURNAL = new Uint8Array([0x0a]);
export type DependencyProjection = Pick<
  Datom,
  "recordedAt" | "recordedPosition" | "retractedAt" | "retractedPosition" | "validFrom" | "validTo"
>;

/** Ordered IEEE timestamp bits, normalized so both zeros share one leaf. */
const instantBits = (instant: number): string =>
  Array.from(encodeTuple(tNumber(instant === 0 ? 0 : instant)).subarray(1), (byte) =>
    byte.toString(2).padStart(8, "0"),
  ).join("");
const journalPrefix = (bits: string) => concat(JOURNAL, encodeTuple(tString(bits)));

/**
 * Covering temporal projection, plus a timestamp trie of position-ordered journals.
 * Each trie prefix supports a reverse, limit-one seek at a captured head. A range
 * maximum visits at most 65 prefixes, even with clock rollback or concurrent commits.
 */
export const readIndexEntries = (datom: Datom): KvEntry[] => {
  const { recordedAt, recordedPosition, retractedAt, retractedPosition, validFrom, validTo } =
    datom;
  const entries: KvEntry[] = [
    [
      concat(DEPENDENCY, encodeTuple(tString(datom.tripleId))),
      encoder.encode(
        JSON.stringify({
          recordedAt,
          recordedPosition,
          retractedAt,
          retractedPosition,
          validFrom,
          validTo,
        }),
      ),
    ],
  ];
  if (datom.entityType === "_Transaction" && datom.attribute === ":_tx/instant") {
    const bits = instantBits(recordedAt);
    for (let length = 0; length <= bits.length; length++)
      entries.push([
        concat(journalPrefix(bits.slice(0, length)), encodeTuple(tNumber(recordedPosition))),
        encoder.encode(String(recordedPosition)),
      ]);
  }
  return entries;
};

export const dependencyProjections = (kv: KvBackendService) =>
  kv.getRange({ start: DEPENDENCY, end: increment(DEPENDENCY) }).pipe(
    Stream.map(([, value]) => JSON.parse(decoder.decode(value)) as DependencyProjection),
    Stream.runCollect,
    Effect.mapError(
      (cause) => new ReadError({ message: "Failed to read KV dependency index", cause }),
    ),
  );

export const recordedPositionAt = (kv: KvBackendService, instant: number, head: number) =>
  Effect.gen(function* () {
    const bits = instantBits(instant);
    const prefixes: string[] = [bits];
    for (let i = 0; i < bits.length; i++)
      if (bits[i] === "1") prefixes.push(bits.slice(0, i) + "0");
    let position = 0;
    for (const bits of prefixes) {
      const rows = yield* Stream.runCollect(
        kv.getRange({
          start: journalPrefix(bits),
          end: increment(concat(journalPrefix(bits), encodeTuple(tNumber(head)))),
          reverse: true,
          limit: 1,
        }),
      );
      if (rows[0]) position = Math.max(position, Number(decoder.decode(rows[0][1])));
    }
    return position;
  }).pipe(
    Effect.mapError(
      (cause) => new ReadError({ message: "Failed to seek KV journal instant index", cause }),
    ),
  );
