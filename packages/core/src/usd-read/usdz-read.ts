/**
 * USDZ package reader: parses the zip central directory + local headers,
 * exposes entries, and checks the USDZ packaging rules (stored entries,
 * 64-byte-aligned payloads, allowed file types, a layer first).
 */
import { diag, type Diagnostic } from '../inspect/diagnostics.js';

export interface UsdzEntry {
  name: string;
  /** Payload offset in the package. */
  offset: number;
  size: number;
  method: number;
  data: Uint8Array;
}

export interface UsdzContainer {
  entries: UsdzEntry[];
  /** First USD layer entry (the package root), or null. */
  layer: UsdzEntry | null;
  specCompliant: boolean;
  violations: string[];
  diagnostics: Diagnostic[];
}

const ALLOWED = /\.(usd|usda|usdc|usdz|png|jpg|jpeg|exr|avif|m4a|mp3|wav)$/i;
const LAYER = /\.(usd|usda|usdc)$/i;

export function readUsdz(bytes: Uint8Array): UsdzContainer {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const diagnostics: Diagnostic[] = [];
  const violations: string[] = [];
  const entries: UsdzEntry[] = [];

  // End of central directory → central directory → local headers.
  let eocd = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (dv.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
  }
  const fail = (msg: string): UsdzContainer => {
    diagnostics.push(diag('USDZ_ARCHIVE_INVALID', '', msg));
    return { entries, layer: null, specCompliant: false, violations: [msg], diagnostics };
  };
  if (eocd < 0) return fail('No end-of-central-directory record found; not a zip archive.');
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) return fail(`Central directory entry ${i} is corrupt.`);
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (localOffset + 30 > bytes.length || dv.getUint32(localOffset, true) !== 0x04034b50) return fail(`Local header for "${name}" is corrupt.`);
    const lNameLen = dv.getUint16(localOffset + 26, true), lExtraLen = dv.getUint16(localOffset + 28, true);
    const offset = localOffset + 30 + lNameLen + lExtraLen;
    if (offset + compSize > bytes.length) return fail(`Entry "${name}" runs past the end of the file.`);
    entries.push({ name, offset, size, method, data: bytes.subarray(offset, offset + compSize) });
  }

  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    if (e.method !== 0) { violations.push(`${e.name}: compressed (method ${e.method}); USDZ requires stored entries.`); diagnostics.push(diag('USDZ_ENTRY_COMPRESSED', '', `${e.name} is compressed (method ${e.method}).`, { property: e.name })); }
    if (e.offset % 64 !== 0) { violations.push(`${e.name}: payload at offset ${e.offset} is not 64-byte aligned.`); diagnostics.push(diag('USDZ_ENTRY_MISALIGNED', '', `${e.name} payload starts at ${e.offset} (offset % 64 = ${e.offset % 64}).`, { property: e.name })); }
    if (!ALLOWED.test(e.name)) { violations.push(`${e.name}: file type not allowed in USDZ.`); diagnostics.push(diag('USDZ_FILE_TYPE_DISALLOWED', '', `${e.name} has a file type the USDZ spec does not allow.`, { property: e.name })); }
    if (/\.usdz$/i.test(e.name)) diagnostics.push(diag('USDZ_NESTED_PACKAGE', '', `${e.name} is a nested usdz package.`, { property: e.name }));
  }
  const files = entries.filter((e) => !e.name.endsWith('/'));
  const layer = files.find((e) => LAYER.test(e.name)) ?? null;
  if (!layer) { violations.push('No USD layer in the package.'); diagnostics.push(diag('USDZ_NO_LAYER', '', 'The package contains no .usd/.usda/.usdc layer.')); }
  else if (files[0] !== layer) { violations.push(`First entry is ${files[0].name}, not a USD layer.`); diagnostics.push(diag('USDZ_LAYER_NOT_FIRST', '', `First entry is ${files[0].name}; the root layer ${layer.name} comes later.`, { property: layer.name })); }

  return { entries, layer, specCompliant: violations.length === 0, violations, diagnostics };
}

/** Resolve an asset path referenced from the package's root layer (relative paths, "./", "0/"-style subdirs). */
export function findUsdzEntry(container: UsdzContainer, assetPath: string, fromLayer: string | null): UsdzEntry | null {
  const clean = assetPath.replace(/^\.\//, '');
  const dir = fromLayer && fromLayer.includes('/') ? fromLayer.slice(0, fromLayer.lastIndexOf('/') + 1) : '';
  const candidates = [clean, dir + clean, clean.replace(/^\//, '')];
  for (const c of candidates) {
    const hit = container.entries.find((e) => e.name === c);
    if (hit) return hit;
  }
  const base = clean.slice(clean.lastIndexOf('/') + 1);
  return container.entries.find((e) => e.name.endsWith('/' + base) || e.name === base) ?? null;
}
