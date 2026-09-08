/**
 * Rendered previews for agents: a PNG the model can look at to verify its
 * own output. Uses core's deterministic software rasterizer (no GPU), so
 * the same file always yields the same bytes.
 */
import type { Document } from '@gltf-transform/core';
import { diffHeatmap, renderRaw, sharpTextureDecoder, thumbnailRig, verifyRig, type RawView } from '@glbforge/core';

export type PreviewKind = 'thumbnail' | 'turntable' | 'none';

export interface ImageBlock { type: 'image'; data: string; mimeType: 'image/png' }

export interface Preview {
  image: ImageBlock;
  png: Uint8Array;
  /** Camera names, in tile order (row-major for turntable sheets). */
  views: string[];
  width: number;
  height: number;
}

const BACKGROUND = { r: 24, g: 25, b: 28, alpha: 1 };

/**
 * thumbnail = one three-quarter hero view; turntable = the 4-camera
 * verification rig tiled 2x2 into a single image (one block, four angles).
 */
export async function renderPreview(doc: Document, kind: PreviewKind, size = 256): Promise<Preview | null> {
  if (kind === 'none') return null;
  const sharp = (await import('sharp')).default;
  const cameras = kind === 'thumbnail' ? thumbnailRig() : verifyRig();
  const views = await renderRaw(doc, { size, cameras, supersample: 2, textureDecoder: sharpTextureDecoder() });
  const raw = { width: size, height: size, channels: 4 as const };
  let png: Buffer;
  let width = size, height = size;
  if (views.length === 1) {
    png = await sharp(Buffer.from(views[0].rgba), { raw }).png().toBuffer();
  } else {
    const cols = 2, rows = Math.ceil(views.length / cols);
    width = size * cols; height = size * rows;
    png = await sharp({ create: { width, height, channels: 4, background: BACKGROUND } })
      .composite(views.map((v, i) => ({
        input: Buffer.from(v.rgba), raw, left: (i % cols) * size, top: Math.floor(i / cols) * size,
      })))
      .png().toBuffer();
  }
  return {
    image: { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    png: new Uint8Array(png),
    views: views.map((v) => v.name),
    width, height,
  };
}

/**
 * Three panels for one camera: reference | candidate | change heatmap. This is
 * what an agent needs when SSIM fails — WHERE the loss is, not just how much.
 */
export async function renderComparison(reference: RawView, candidate: RawView, labels = ['reference', 'result', 'change']): Promise<Preview> {
  const sharp = (await import('sharp')).default;
  const size = reference.size;
  const heat = diffHeatmap(reference, candidate);
  const panels = [reference, candidate, heat];
  const raw = { width: size, height: size, channels: 4 as const };
  const label = (text: string, i: number) => ({
    input: Buffer.from(`<svg width="${size}" height="20"><rect width="${size}" height="20" fill="#000" fill-opacity="0.55"/><text x="6" y="14" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#fff">${text}</text></svg>`),
    left: i * size, top: 0,
  });
  const png = await sharp({ create: { width: size * 3, height: size, channels: 4, background: BACKGROUND } })
    .composite([
      ...panels.map((v, i) => ({ input: Buffer.from(v.rgba), raw, left: i * size, top: 0 })),
      ...labels.map(label),
    ])
    .png().toBuffer();
  return {
    image: { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    png: new Uint8Array(png),
    views: [reference.name, candidate.name, heat.name],
    width: size * 3, height: size,
  };
}
