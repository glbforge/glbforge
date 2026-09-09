/**
 * Decoders for the crate file's compressed sections: LZ4 block format,
 * TfFastCompression framing (chunk byte + LZ4 block(s)) and Pixar's
 * Usd_IntegerCompression (delta + 2-bit codes). Mirrors usdc.ts's encoders.
 */

/** Decode one LZ4 block. `capacity` is the expected (maximum) output size; the result is trimmed to what was produced. */
export function lz4DecompressBlock(src: Uint8Array, capacity: number): Uint8Array {
  let out = new Uint8Array(Math.max(16, capacity));
  let o = 0, i = 0;
  const n = src.length;
  const ensure = (extra: number) => {
    if (o + extra <= out.length) return;
    let size = out.length * 2;
    while (size < o + extra) size *= 2;
    const next = new Uint8Array(size); next.set(out.subarray(0, o)); out = next;
  };
  while (i < n) {
    const token = src[i++];
    let lit = token >>> 4;
    if (lit === 15) { let b; do { b = src[i++]; lit += b; } while (b === 255 && i < n); }
    ensure(lit);
    out.set(src.subarray(i, i + lit), o); o += lit; i += lit;
    if (i >= n) break;
    const offset = src[i] | (src[i + 1] << 8); i += 2;
    let match = (token & 15) + 4;
    if ((token & 15) === 15) { let b; do { b = src[i++]; match += b; } while (b === 255 && i < n); }
    if (offset === 0 || offset > o) throw new Error('lz4: bad match offset');
    ensure(match);
    let from = o - offset;
    for (let k = 0; k < match; k++) out[o++] = out[from++];
  }
  return out.subarray(0, o);
}

/** TfFastCompression: 1 chunk-count byte (0 = one block) then LZ4 block(s); multi-chunk = int32 size + block each. */
export function tfDecompress(src: Uint8Array, capacity: number): Uint8Array {
  const chunks = src[0];
  if (chunks === 0) return lz4DecompressBlock(src.subarray(1), capacity);
  const parts: Uint8Array[] = [];
  let p = 1, total = 0;
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  for (let c = 0; c < chunks; c++) {
    const size = dv.getInt32(p, true); p += 4;
    const part = lz4DecompressBlock(src.subarray(p, p + size), Math.ceil(capacity / chunks) + 64);
    parts.push(part); total += part.length; p += size;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of parts) { out.set(part, o); o += part.length; }
  return out;
}

/** Upper bound of Usd_IntegerCompression's encoded size for n values (what the LZ4 stage decodes to). */
export const intCompressedBound = (n: number, wide = false) => (wide ? 8 : 4) + ((n * 2 + 7) >> 3) + n * (wide ? 8 : 4);

/** Usd_IntegerCompression (32-bit): int32 common delta · 2-bit codes (4 per byte, low bits first) · non-common deltas. */
export function decompressInts32(buf: Uint8Array, n: number): Int32Array {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const common = dv.getInt32(0, true);
  const codesLen = (n * 2 + 7) >> 3;
  let d = 4 + codesLen;
  const out = new Int32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const code = (buf[4 + (i >> 2)] >> ((i & 3) * 2)) & 3;
    let delta: number;
    if (code === 0) delta = common;
    else if (code === 1) { delta = dv.getInt8(d); d += 1; }
    else if (code === 2) { delta = dv.getInt16(d, true); d += 2; }
    else { delta = dv.getInt32(d, true); d += 4; }
    prev = (prev + delta) | 0;
    out[i] = prev;
  }
  return out;
}

/** Usd_IntegerCompression64: int64 common · codes · int8/int16/int64 deltas. Values returned as Numbers. */
export function decompressInts64(buf: Uint8Array, n: number): Float64Array {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const common = dv.getBigInt64(0, true);
  const codesLen = (n * 2 + 7) >> 3;
  let d = 8 + codesLen;
  const out = new Float64Array(n);
  let prev = 0n;
  for (let i = 0; i < n; i++) {
    const code = (buf[8 + (i >> 2)] >> ((i & 3) * 2)) & 3;
    let delta: bigint;
    if (code === 0) delta = common;
    else if (code === 1) { delta = BigInt(dv.getInt8(d)); d += 1; }
    else if (code === 2) { delta = BigInt(dv.getInt16(d, true)); d += 2; }
    else { delta = dv.getBigInt64(d, true); d += 8; }
    prev += delta;
    out[i] = Number(prev);
  }
  return out;
}

/** IEEE 754 binary16 → number. */
export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f, mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}
