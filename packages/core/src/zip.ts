/**
 * Minimal store-only ZIP writer for USDZ. The USDZ spec requires: no
 * compression, every file's data 64-byte aligned (padding via an extra
 * field), and the first entry to be the USD layer. Timestamps are pinned to
 * 1980-01-01 so the same input always yields the same bytes.
 */
export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ALIGN = 64;
const DOS_TIME = 0x0000;   // 00:00:00
const DOS_DATE = 0x0021;   // 1980-01-01

export function storeZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = enc.encode(entry.name);
    const crc = crc32(entry.data);
    // Pad the local header's extra field so the payload starts on a 64-byte
    // boundary (USD's own writer uses extra-field id 0x1986 for this).
    const headerEnd = offset + 30 + name.length;
    let pad = (ALIGN - (headerEnd % ALIGN)) % ALIGN;
    if (pad > 0 && pad < 4) pad += ALIGN;
    const extra = new Uint8Array(pad);
    if (pad) {
      const v = new DataView(extra.buffer);
      v.setUint16(0, 0x1986, true);
      v.setUint16(2, pad - 4, true);
    }

    const local = new Uint8Array(30);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);            // version needed: 2.0
    lv.setUint16(6, 0, true);             // flags
    lv.setUint16(8, 0, true);             // method: stored
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, entry.data.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, extra.length, true);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);            // version made by
    cv.setUint16(6, 20, true);            // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);            // extra (central) length
    cv.setUint16(32, 0, true);            // comment length
    cv.setUint16(34, 0, true);            // disk number
    cv.setUint16(36, 0, true);            // internal attrs
    cv.setUint32(38, 0, true);            // external attrs
    cv.setUint32(42, offset, true);       // local header offset
    cd.set(name, 46);
    central.push(cd);

    parts.push(local, name, extra, entry.data);
    offset += local.length + name.length + extra.length + entry.data.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) { parts.push(c); cdSize += c.length; }
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  ev.setUint16(20, 0, true);
  parts.push(eocd);

  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Parse local headers (for tests / validation): names and payload offsets. */
export function listZip(zip: Uint8Array): Array<{ name: string; offset: number; size: number; method: number }> {
  const dec = new TextDecoder();
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out = [];
  let p = 0;
  while (p + 30 <= zip.length && v.getUint32(p, true) === 0x04034b50) {
    const method = v.getUint16(p + 8, true);
    const size = v.getUint32(p + 18, true);
    const nameLen = v.getUint16(p + 26, true);
    const extraLen = v.getUint16(p + 28, true);
    const name = dec.decode(zip.subarray(p + 30, p + 30 + nameLen));
    const offset = p + 30 + nameLen + extraLen;
    out.push({ name, offset, size, method });
    p = offset + size;
  }
  return out;
}
