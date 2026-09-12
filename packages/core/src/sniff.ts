/**
 * What is this file, actually?
 *
 * Filenames and MIME types are what the *operating system* thinks, and on a
 * phone they are routinely wrong or missing: a picker can hand over `image`
 * with no extension and an empty `type`, and a Files provider can hand over a
 * photo typed `application/octet-stream`. Routing on those signals sends a
 * perfectly good photograph down the GLB path, where it dies as "Invalid glTF
 * 2.0 binary" — a true statement about the wrong question.
 *
 * The bytes do not lie, so ask them first. This is a magic-number sniff over
 * the formats the pipeline actually accepts; name and type are the fallback,
 * not the authority.
 */

export type FileKind =
  | 'glb'           // binary glTF
  | 'gltf'          // JSON glTF
  | 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp' | 'tiff'
  | 'heic'          // also HEIF; Safari decodes these, other browsers do not
  | 'avif'
  | 'svg'
  | 'usdz' | 'usdc' | 'usda'
  | 'unknown';

/** Image kinds, as a set — the forge and the generators take these. */
const IMAGE_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  'png', 'jpeg', 'webp', 'gif', 'bmp', 'tiff', 'heic', 'avif', 'svg',
]);

export const isImageKind = (kind: FileKind): boolean => IMAGE_KINDS.has(kind);

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length
  && signature.every((byte, i) => bytes[offset + i] === byte);

/**
 * Identify a file from its leading bytes. Returns 'unknown' rather than
 * guessing — the caller then has something honest to say about it.
 */
export function sniffFileKind(bytes: Uint8Array): FileKind {
  if (bytes.length < 4) return 'unknown';

  // glTF: magic 'glTF' + a version word.
  if (ascii(bytes, 0, 4) === 'glTF') return 'glb';

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif';           // GIF8
  if (startsWith(bytes, [0x42, 0x4d])) return 'bmp';                        // BM
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00])
    || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';

  // ISO base media: the brand at offset 8 says which flavour. HEIC is what an
  // iPhone hands over for a camera-roll photo when nothing asks it to convert.
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4).toLowerCase();
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (brand.startsWith('hei') || brand === 'mif1' || brand === 'msf1'
      || brand === 'hevc' || brand === 'hevx') return 'heic';
  }

  // Zip container: a USDZ is a store-only zip whose first entry is the layer.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return ascii(bytes, 0, 4096).includes('.usd') ? 'usdz' : 'unknown';
  }
  if (ascii(bytes, 0, 8) === 'PXR-USDC') return 'usdc';

  // Text formats last: decode a little and look.
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 512)).trimStart();
  const lower = head.toLowerCase();
  if (lower.startsWith('<svg') || (lower.startsWith('<?xml') && lower.includes('<svg'))) return 'svg';
  if (head.startsWith('#usda')) return 'usda';
  if (head.startsWith('{')) {
    // A glTF JSON has an "asset" block with a version; anything else is some
    // other JSON and not ours to claim.
    return /"asset"\s*:\s*\{/.test(ascii(bytes, 0, Math.min(bytes.length, 4096))) ? 'gltf' : 'unknown';
  }
  return 'unknown';
}

/** A short, human description of what the bytes looked like, for error messages. */
export function describeBytes(bytes: Uint8Array): string {
  if (!bytes.length) return 'the file is empty';
  const hex = [...bytes.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  return `starts with ${hex}`;
}
