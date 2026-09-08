/**
 * Comparison sheet: reference | candidate | change heatmap for one camera,
 * as a single RGBA image. Pure composition (works in browsers via canvas);
 * `renderSheetPng` is the Node convenience that encodes it with sharp and
 * stamps panel labels.
 */
import { diffHeatmap } from './perceptual.js';
import type { RawView } from './render.js';

export interface SheetImage { rgba: Uint8Array; width: number; height: number; views: string[] }

export function composeSheet(reference: RawView, candidate: RawView): SheetImage {
  if (reference.size !== candidate.size) throw new Error('composeSheet: views differ in size');
  const size = reference.size;
  const heat = diffHeatmap(reference, candidate);
  const panels = [reference, candidate, heat];
  const width = size * 3, height = size;
  const rgba = new Uint8Array(width * height * 4);
  panels.forEach((v, p) => {
    for (let y = 0; y < size; y++) {
      rgba.set(v.rgba.subarray(y * size * 4, (y + 1) * size * 4), (y * width + p * size) * 4);
    }
  });
  return { rgba, width, height, views: [reference.name, candidate.name, heat.name] };
}

/** Node: PNG-encode the sheet with labels over each panel. */
export async function renderSheetPng(
  reference: RawView, candidate: RawView, labels = ['reference', 'result', 'change'],
): Promise<{ png: Uint8Array; sheet: SheetImage }> {
  const sharp = (await import('sharp')).default;
  const sheet = composeSheet(reference, candidate);
  const size = reference.size;
  const label = (text: string, i: number) => ({
    input: Buffer.from(`<svg width="${size}" height="20"><rect width="${size}" height="20" fill="#000" fill-opacity="0.55"/><text x="6" y="14" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#fff">${text}</text></svg>`),
    left: i * size, top: 0,
  });
  const png = await sharp(Buffer.from(sheet.rgba), { raw: { width: sheet.width, height: sheet.height, channels: 4 } })
    .composite(labels.map(label)).png().toBuffer();
  return { png: new Uint8Array(png), sheet };
}
