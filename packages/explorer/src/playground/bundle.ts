/**
 * A shareable playground: entity types, seed commands and saved Datalog queries
 * as plain JSON, so a link can carry it and a browser can rebuild the database
 * from it. Nothing in a bundle is executed as code.
 */
import { Schema } from "effect";

const Instant = Schema.Union([Schema.String, Schema.Number]);

export const AttributeSpec = Schema.Struct({
  key: Schema.String,
  type: Schema.Literals(["text", "number", "integer", "boolean", "date", "instant", "enum", "ref"]),
  /** Allowed values of an `enum` attribute. */
  values: Schema.optional(Schema.Array(Schema.String)),
  /** The entity type a `ref` attribute points at. */
  target: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
  many: Schema.optional(Schema.Boolean),
  unique: Schema.optional(Schema.Boolean),
});
export type AttributeSpec = typeof AttributeSpec.Type;

export const TypeSpec = Schema.Struct({
  name: Schema.String,
  /** Aliased attributes, as in `EntityType.make(name, { alias: Attribute… })`. */
  attributes: Schema.Record(Schema.String, AttributeSpec),
});
export type TypeSpec = typeof TypeSpec.Type;

export const EntityWrite = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  values: Schema.Record(Schema.String, Schema.Unknown),
  /** Overrides the command's `at` for this entity. */
  validFrom: Schema.optional(Instant),
  validTo: Schema.optional(Instant),
});
export type EntityWrite = typeof EntityWrite.Type;

/** One attributed transaction. Creates assert from `at`; updates replace values from `at` on. */
export const SeedCommand = Schema.Struct({
  actor: Schema.String,
  commandId: Schema.optional(Schema.String),
  /** Valid-time start: an ISO date or epoch milliseconds. Omitted means commit time. */
  at: Schema.optional(Instant),
  note: Schema.optional(Schema.String),
  create: Schema.optional(Schema.Array(EntityWrite)),
  update: Schema.optional(Schema.Array(EntityWrite)),
});
export type SeedCommand = typeof SeedCommand.Type;

export const SavedQuery = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  /** A Triplex Datalog query, exactly as `Triples.query` takes it. */
  query: Schema.Record(Schema.String, Schema.Unknown),
});
export type SavedQuery = typeof SavedQuery.Type;

export const Bundle = Schema.Struct({
  version: Schema.Literal(1),
  title: Schema.String,
  description: Schema.optional(Schema.String),
  types: Schema.Array(TypeSpec),
  seed: Schema.Array(SeedCommand),
  queries: Schema.Array(SavedQuery),
});
export type Bundle = typeof Bundle.Type;

export const decodeBundle = Schema.decodeUnknownSync(Bundle);

export const HASH_PREFIX = "#bundle=";
/** Links longer than this get unwieldy in chat apps and some browsers. */
export const MAX_LINK_BYTES = 32 * 1024;

const pipeBytes = async (bytes: Uint8Array, stream: GenericTransformStream) =>
  new Uint8Array(
    await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer(),
  );

const toBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const fromBase64Url = (text: string) => {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

/** `#bundle=` followed by the deflated JSON in base64url. */
export const encodeBundle = async (bundle: Bundle): Promise<string> =>
  HASH_PREFIX +
  toBase64Url(
    await pipeBytes(
      new TextEncoder().encode(JSON.stringify(bundle)),
      new CompressionStream("deflate-raw"),
    ),
  );

/** The bundle in a `#bundle=` hash; throws when the hash is damaged or not a version 1 bundle. */
export const decodeHash = async (hash: string): Promise<Bundle | null> => {
  if (!hash.startsWith(HASH_PREFIX)) return null;
  let json: unknown;
  try {
    const bytes = await pipeBytes(
      fromBase64Url(hash.slice(HASH_PREFIX.length)),
      new DecompressionStream("deflate-raw"),
    );
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("the link is damaged or cut short");
  }
  return decodeBundle(json);
};
