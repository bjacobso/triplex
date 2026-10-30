/**
 * Attached segments, as the hexastore sees them.
 *
 * Attaching a segment writes one KV record, `0x30 + position` → `{ segment,
 * txId, instant, actor }`, in the attaching transaction. The segment body
 * lives in the backend's `SegmentStore`. Reads merge each attached segment's
 * facts with the indexed ones; the attachment supplies their recorded time.
 *
 * A segment fact's triple ID encodes where it lives: `U`, the attachment's
 * position in 12 base-32 digits, and the fact's ordinal in 13. ULIDs never
 * contain `U`, so these can't collide with generated IDs. Retracting a segment
 * fact writes its datom to META like any retraction; that record overrides the
 * immutable segment copy.
 */

import type { ResolvedTemporalBasis } from "../../Temporal.js";
import * as Segment from "../../segment/Segment.js";
import type { Datom } from "./KvTripleStore.js";

export const ATTACHMENT_PREFIX = 0x30;

const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const base32 = (n: number, digits: number): string => {
  let out = "";
  for (let i = 0; i < digits; i++) {
    out = BASE32[n % 32]! + out;
    n = Math.floor(n / 32);
  }
  return out;
};

const fromBase32 = (s: string): number => {
  let n = 0;
  for (const c of s) {
    const digit = BASE32.indexOf(c);
    if (digit < 0) return Number.NaN;
    n = n * 32 + digit;
  }
  return n;
};

export interface Attachment {
  readonly position: number;
  readonly txId: string;
  readonly instant: number;
  readonly actor: string | null;
  readonly segment: Segment.Segment;
  /** Triple-ID prefix shared by this attachment's facts. */
  readonly idPrefix: string;
}

export const idPrefix = (position: number): string => `U${base32(position, 12)}`;

export const tripleId = (attachment: Attachment, ordinal: number): string =>
  attachment.idPrefix + base32(ordinal, 13);

/** The attachment position and ordinal a segment triple ID points to, if it is one. */
export const parseTripleId = (
  id: string,
): { readonly position: number; readonly ordinal: number } | undefined => {
  if (id.length !== 26 || id[0] !== "U") return undefined;
  const position = fromBase32(id.slice(1, 13));
  const ordinal = fromBase32(id.slice(13));
  return Number.isSafeInteger(position) && Number.isSafeInteger(ordinal)
    ? { position, ordinal }
    : undefined;
};

export const attachmentKey = (position: number): Uint8Array => {
  const key = new Uint8Array(9);
  key[0] = ATTACHMENT_PREFIX;
  new DataView(key.buffer).setBigUint64(1, BigInt(position), false);
  return key;
};

export const ATTACHMENT_RANGE = {
  start: new Uint8Array([ATTACHMENT_PREFIX]),
  end: new Uint8Array([ATTACHMENT_PREFIX + 1]),
};

interface AttachmentRecord {
  readonly segment: string;
  readonly txId: string;
  readonly instant: number;
  readonly actor: string | null;
}

export const encodeAttachment = (record: AttachmentRecord): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(record));

export const decodeAttachment = (
  key: Uint8Array,
  value: Uint8Array,
  segments: { readonly get: (id: string) => Segment.Segment | undefined } | undefined,
): Attachment => {
  const position = Number(new DataView(key.buffer, key.byteOffset, 9).getBigUint64(1, false));
  const record = JSON.parse(new TextDecoder().decode(value)) as AttachmentRecord;
  const segment = segments?.get(record.segment);
  if (segment === undefined) {
    throw new Error(`Attached segment ${record.segment} is not in this backend's segment store`);
  }
  return { position, ...record, segment, idPrefix: idPrefix(position) };
};

/** The datom for fact `ordinal` of an attachment, before any retraction. */
export const datomAt = (attachment: Attachment, ordinal: number): Datom => {
  const s = attachment.segment;
  const validFrom = s.validFrom[ordinal]!;
  const validTo = s.validTo[ordinal]!;
  const entityType = s.entityType[ordinal]!;
  const createdBy = s.createdBy[ordinal]!;
  return {
    tripleId: tripleId(attachment, ordinal),
    entity: s.strings[s.entity[ordinal]!]!,
    attribute: s.strings[s.attribute[ordinal]!]!,
    value: Segment.valueAt(s, ordinal),
    txId: attachment.txId,
    recordedAt: attachment.instant,
    recordedPosition: attachment.position,
    validFrom: validFrom !== validFrom ? attachment.instant : validFrom,
    validTo: validTo !== validTo ? null : validTo,
    createdBy: createdBy < 0 ? attachment.actor : s.strings[createdBy]!,
    retractedAt: null,
    retractedPosition: null,
    retractTxId: null,
    entityType: entityType < 0 ? null : s.strings[entityType]!,
  };
};

/** Whether any fact of an attachment can be visible at `basis` (ignoring retraction). */
export const attachmentVisible = (attachment: Attachment, basis: ResolvedTemporalBasis): boolean =>
  (basis.recordedPosition === undefined || attachment.position <= basis.recordedPosition) &&
  (basis.recordedAt === undefined || attachment.instant <= basis.recordedAt);

/** Whether fact `ordinal` is valid at `validAt`, from the columns alone. */
export const validAt = (attachment: Attachment, ordinal: number, at: number): boolean => {
  const s = attachment.segment;
  const from = s.validFrom[ordinal]!;
  const to = s.validTo[ordinal]!;
  return (from !== from ? attachment.instant : from) <= at && (to !== to || to > at);
};
