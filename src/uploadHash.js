/** Pure-JS hashing for the direct-to-Drive upload flow.
 *
 *  - md5Blob / Md5: streaming MD5 of the *whole* file. Google Drive reports `md5Checksum` for every binary file it stores,
 *    so comparing the two proves the stored bytes are exactly the bytes on the user's disk. SubtleCrypto has no MD5 and no
 *    streaming digest, hence this implementation (chunked, so memory stays at one chunk even for multi-GB files).
 *  - sha256Bytes: one-shot SHA-256 used only when `crypto.subtle` is unavailable (non-secure context / old WebView).
 */

const K = new Int32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
const S1 = [7, 12, 17, 22], S2 = [5, 9, 14, 20], S3 = [4, 11, 16, 23], S4 = [6, 10, 15, 21];

export class Md5 {
  constructor() {
    this.s = new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476]);
    this.tail = new Uint8Array(64);
    this.tailLen = 0;
    this.total = 0;
    this.w = new Int32Array(16);
  }

  block(bytes, o) {
    const w = this.w;
    for (let i = 0; i < 16; i++, o += 4) w[i] = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
    let a = this.s[0], b = this.s[1], c = this.s[2], d = this.s[3];
    let f, r, i = 0;
    for (; i < 16; i++) { f = (((b & c) | (~b & d)) + a + K[i] + w[i]) | 0; a = d; d = c; c = b; r = S1[i & 3]; b = (b + ((f << r) | (f >>> (32 - r)))) | 0; }
    for (; i < 32; i++) { f = (((d & b) | (~d & c)) + a + K[i] + w[(5 * i + 1) & 15]) | 0; a = d; d = c; c = b; r = S2[i & 3]; b = (b + ((f << r) | (f >>> (32 - r)))) | 0; }
    for (; i < 48; i++) { f = ((b ^ c ^ d) + a + K[i] + w[(3 * i + 5) & 15]) | 0; a = d; d = c; c = b; r = S3[i & 3]; b = (b + ((f << r) | (f >>> (32 - r)))) | 0; }
    for (; i < 64; i++) { f = ((c ^ (b | ~d)) + a + K[i] + w[(7 * i) & 15]) | 0; a = d; d = c; c = b; r = S4[i & 3]; b = (b + ((f << r) | (f >>> (32 - r)))) | 0; }
    this.s[0] = (this.s[0] + a) | 0; this.s[1] = (this.s[1] + b) | 0; this.s[2] = (this.s[2] + c) | 0; this.s[3] = (this.s[3] + d) | 0;
  }

  update(bytes) {
    this.total += bytes.length;
    let pos = 0;
    if (this.tailLen) {
      const take = Math.min(64 - this.tailLen, bytes.length);
      this.tail.set(bytes.subarray(0, take), this.tailLen);
      this.tailLen += take; pos = take;
      if (this.tailLen < 64) return this;
      this.block(this.tail, 0); this.tailLen = 0;
    }
    for (; pos + 64 <= bytes.length; pos += 64) this.block(bytes, pos);
    if (pos < bytes.length) { this.tail.set(bytes.subarray(pos), 0); this.tailLen = bytes.length - pos; }
    return this;
  }

  hex() {
    const bitsLow = (this.total * 8) >>> 0;
    const bitsHigh = Math.floor(this.total / 536870912) >>> 0; // total * 8 / 2^32
    const padLen = (this.tailLen < 56 ? 56 : 120) - this.tailLen;
    const pad = new Uint8Array(padLen + 8);
    pad[0] = 0x80;
    for (let i = 0; i < 4; i++) { pad[padLen + i] = (bitsLow >>> (8 * i)) & 255; pad[padLen + 4 + i] = (bitsHigh >>> (8 * i)) & 255; }
    const savedTotal = this.total;
    this.update(pad);
    this.total = savedTotal;
    let out = "";
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) out += ((this.s[i] >>> (8 * j)) & 255).toString(16).padStart(2, "0");
    return out;
  }
}

/** Streams a Blob/File through MD5 in `chunkBytes` slices. `onProgress(0..100)`; `isCancelled()` aborts early (resolves null). */
export async function md5Blob(blob, { chunkBytes = 8 * 1024 * 1024, onProgress, isCancelled } = {}) {
  const md5 = new Md5();
  const size = blob.size;
  let lastPct = -1;
  for (let offset = 0; offset < size; offset += chunkBytes) {
    if (isCancelled?.()) return null;
    md5.update(new Uint8Array(await blob.slice(offset, Math.min(size, offset + chunkBytes)).arrayBuffer()));
    const pct = Math.min(100, Math.floor((Math.min(size, offset + chunkBytes) / size) * 100));
    if (pct !== lastPct) { lastPct = pct; onProgress?.(pct); }
  }
  return md5.hex();
}

// ---------------------------------------------------------------- SHA-256 (fallback)
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Bytes(bytes) {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes); padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(len / 536870912) >>> 0);
  view.setUint32(padded.length - 4, (len * 8) >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}
