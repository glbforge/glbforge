/**
 * Rendered previews for agents: a PNG the model can look at to verify its
 * own output. Uses core's deterministic software rasterizer (no GPU), so
 * the same file always yields the same bytes.
 */
import type { Document } from '@gltf-transform/core';
import { renderRaw, renderSheetPng, sharpTextureDecoder, thumbnailRig, verifyRig, type RawView } from '@glbforge/core';

export type PreviewKind = 'thumbnail' | 'turntable' | 'none';

export interface ImageBlock { type: 'image'; data: string; mimeType: 'image/png' }

export interface Preview {
  image: ImageBlock;
  png: Uint8Array;
  /** Camera names, in tile order (row-major for turntable sheets). */
  views: string[];
  /** The camera behind each tile: what the agent is looking at. */
  cameras: Array<{ name: string; camera: { position: [number, number, number]; target: [number, number, number]; fov: number } }>;
  width: number;
  height: number;
}

export const cameraOfView = (v: RawView) => ({ name: v.name, camera: { position: v.camera.position, target: v.camera.target, fov: v.camera.fovDeg } });

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
    cameras: views.map(cameraOfView),
    width, height,
  };
}

/** Three panels for one camera: reference | candidate | change heatmap (see core's renderSheetPng). */
export async function renderComparison(reference: RawView, candidate: RawView, labels = ['reference', 'result', 'change']): Promise<Preview> {
  const { png, sheet } = await renderSheetPng(reference, candidate, labels);
  return {
    image: { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
    png, views: sheet.views, cameras: [cameraOfView(reference)], width: sheet.width, height: sheet.height,
  };
}

/** Tile N raw views into one PNG contact sheet (row-major, `columns` per row), with a label over each tile. */
export async function renderContactSheet(views: RawView[], labels: string[], columns = 4): Promise<Preview> {
  const sharp = (await import('sharp')).default;
  if (views.length === 0) throw new Error('renderContactSheet: no views');
  const size = views[0].size;
  const cols = Math.min(columns, views.length), rows = Math.ceil(views.length / cols);
  const width = size * cols, height = size * rows;
  const raw = { width: size, height: size, channels: 4 as const };
  const label = (text: string, i: number) => ({
    input: Buffer.from(`<svg width="${size}" height="18"><rect width="${size}" height="18" fill="#000" fill-opacity="0.55"/><text x="5" y="13" font-family="Helvetica,Arial,sans-serif" font-size="11" fill="#fff">${text.replace(/[<>&]/g, '')}</text></svg>`),
    left: (i % cols) * size, top: Math.floor(i / cols) * size,
  });
  const png = await sharp({ create: { width, height, channels: 4, background: BACKGROUND } })
    .composite([
      ...views.map((v, i) => ({ input: Buffer.from(v.rgba), raw, left: (i % cols) * size, top: Math.floor(i / cols) * size })),
      ...labels.slice(0, views.length).map(label),
    ])
    .png().toBuffer();
  return {
    image: { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    png: new Uint8Array(png), views: views.map((v) => v.name), cameras: views.map(cameraOfView), width, height,
  };
}

/** Animated GIF from raw frames (for human reviewers; agents read the contact sheet). */
export async function renderGif(views: RawView[], delayMs = 100): Promise<Uint8Array> {
  const sharp = (await import('sharp')).default;
  const size = views[0].size;
  const stacked = Buffer.concat(views.map((v) => Buffer.from(v.rgba)));
  const gif = await sharp(stacked, { raw: { width: size, height: size * views.length, channels: 4 }, animated: false })
    .toFormat('gif')
    .toBuffer();
  // sharp encodes multi-page GIFs from a tall raw buffer via `pages`; rebuild with page metadata.
  const animated = await sharp(stacked, { raw: { width: size, height: size * views.length, channels: 4, pageHeight: size } as never })
    .gif({ delay: views.map(() => delayMs), loop: 0 })
    .toBuffer()
    .catch(() => gif);
  return new Uint8Array(animated);
}
