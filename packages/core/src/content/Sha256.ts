/**
 * SHA-256, with no dependency on Node.
 *
 * `ContentId` previously imported `node:crypto`, which makes this package
 * unusable in a browser. That matters because the configuration kernel is meant
 * to decode and validate the same declarations on the server, in the browser
 * builder, in the CLI and in tests - a kernel that only runs on Node forces a
 * second implementation for the authoring surface, and two implementations of a
 * content hash is precisely the thing this whole design cannot survive.
 *
 * `crypto.subtle.digest` is the obvious browser answer and is rejected here for
 * one reason: it is asynchronous. `TypeExpr.id`, `ConfigNode.diff` and the
 * canonical encoders are synchronous by design, and making identity async would
 * push a Promise into every comparison in the system to avoid one dependency.
 *
 * So the algorithm is written out. It is ~60 lines of well-specified arithmetic
 * with a total test oracle available - `Sha256.test.ts` compares it against
 * `node:crypto` over random and adversarial inputs, so a transcription error
 * cannot survive a test run. That is a better trade than a supply-chain
 * dependency in the one function every identity in the store rests on.
 */

// First 32 bits of the fractional parts of the cube roots of the first 64
// primes. Any transcription error here is caught by the differential test.
const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const HEX = "0123456789abcdef";

const INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/**
 * Compress the 64-byte blocks of `bytes` from `offset` to `end` into `h`.
 * Signed 32-bit arithmetic (`| 0`) and locals keep V8 on its integer fast path.
 */
const compress = (h: Int32Array, w: Int32Array, bytes: Uint8Array, offset: number, end: number) => {
  let h0 = h[0]!,
    h1 = h[1]!,
    h2 = h[2]!,
    h3 = h[3]!,
    h4 = h[4]!,
    h5 = h[5]!,
    h6 = h[6]!,
    h7 = h[7]!;
  for (; offset < end; offset += 64) {
    for (let i = 0, j = offset; i < 16; i++, j += 4) {
      w[i] = (bytes[j]! << 24) | (bytes[j + 1]! << 16) | (bytes[j + 2]! << 8) | bytes[j + 3]!;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      hh = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i]! + w[i]!) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + hh) | 0;
  }
  h[0] = h0;
  h[1] = h1;
  h[2] = h2;
  h[3] = h3;
  h[4] = h4;
  h[5] = h5;
  h[6] = h6;
  h[7] = h7;
};

const encoder = new TextEncoder();

/**
 * Incremental SHA-256 over UTF-8 text and bytes, for content too large to
 * build as one string. `hex(a + b)` equals `create().update(a).update(b).hex()`.
 */
export interface Hasher {
  readonly update: (input: string | Uint8Array) => Hasher;
  /** Finish and return the lowercase hex digest. The hasher can't be reused. */
  readonly hex: () => string;
}

export const create = (): Hasher => {
  const h = new Int32Array(INITIAL);
  const w = new Int32Array(64);
  // Bytes not yet compressed: always fewer than 64 between updates.
  let pending = new Uint8Array(64);
  let pendingLength = 0;
  let length = 0;
  let finished = false;

  const updateBytes = (bytes: Uint8Array) => {
    length += bytes.length;
    let offset = 0;
    if (pendingLength > 0) {
      const take = Math.min(64 - pendingLength, bytes.length);
      pending.set(bytes.subarray(0, take), pendingLength);
      pendingLength += take;
      offset = take;
      if (pendingLength < 64) return;
      compress(h, w, pending, 0, 64);
      pendingLength = 0;
    }
    const whole = offset + Math.floor((bytes.length - offset) / 64) * 64;
    compress(h, w, bytes, offset, whole);
    pending.set(bytes.subarray(whole), 0);
    pendingLength = bytes.length - whole;
  };

  const hasher: Hasher = {
    update: (input) => {
      if (finished) throw new Error("SHA-256 hasher already finished");
      updateBytes(typeof input === "string" ? encoder.encode(input) : input);
      return hasher;
    },
    hex: () => {
      if (finished) throw new Error("SHA-256 hasher already finished");
      finished = true;
      // A 0x80 terminator, zero padding, then the 64-bit big-endian bit length.
      const tail = new Uint8Array(pendingLength + 9 <= 64 ? 64 : 128);
      tail.set(pending.subarray(0, pendingLength));
      tail[pendingLength] = 0x80;
      const view = new DataView(tail.buffer);
      // Split across two 32-bit writes: a JS number cannot hold a 64-bit length,
      // and inputs long enough to reach the high word are not representable anyway.
      view.setUint32(tail.length - 8, Math.floor((length * 8) / 0x100000000));
      view.setUint32(tail.length - 4, (length * 8) >>> 0);
      compress(h, w, tail, 0, tail.length);
      pending = new Uint8Array(0);
      let out = "";
      for (let i = 0; i < 8; i++) {
        const word = h[i]! >>> 0;
        for (let shift = 28; shift >= 0; shift -= 4) {
          out += HEX[(word >>> shift) & 0xf]!;
        }
      }
      return out;
    },
  };
  return hasher;
};

/** Lowercase hex SHA-256 of a string, encoded as UTF-8. */
export const hex = (input: string): string => create().update(input).hex();
