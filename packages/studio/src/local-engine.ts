/**
 * Browser-side pipeline: the same analyze/optimize/forge/STL flow as the
 * `glbforge ui` server, running entirely in the visitor's browser. Nothing
 * is uploaded anywhere; Meshy generation requires the local CLI.
 */
import { WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import {
  analyze,
  applyPerceptualVerdict,
  composeSheet,
  extrudeFromRgba,
  getProfile,
  optimize,
  PROFILES,
  toStl,
  toUsdz,
  type AnalysisResult,
  type UsdzTextureEncoder,
  type PerceptualVerdict,
  type TextureDecoder,
  type TextureEncoder,
} from '@glbforge/core';
import { registerLocalUrls, type AssetDetail, type AssetSummary } from './api';
import { loadAssets, persistAsset } from './persist';

interface LocalAsset {
  id: string;
  name: string;
  bytes: Uint8Array;
  report: AnalysisResult;
  parentId?: string;
  blobUrl: string;
  fidelitySheet?: string | null;
}

const assets = new Map<string, LocalAsset>();
let nextId = 1;
registerLocalUrls((id) => assets.get(id)?.blobUrl ?? '');

async function createIO(): Promise<WebIO> {
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  return new WebIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    });
}

const toDetail = (a: LocalAsset): AssetDetail => ({
  id: a.id,
  name: a.name,
  bytes: a.bytes.byteLength,
  score: a.report.score,
  passed: a.report.passed,
  triangles: a.report.geometry.triangles,
  parentId: a.parentId ?? null,
  steps: null,
  report: a.report as unknown as AssetDetail['report'],
  fidelitySheet: a.fidelitySheet ?? null,
});

/** Constrained device: coarse pointer / low reported memory / mobile UA. */
const CONSTRAINED =
  typeof navigator !== 'undefined' &&
  (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ||
    ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) <= 4);

/** Draw the reference | result | change sheet for the weakest view into a data URL. */
function sheetDataUrl(perceptual: PerceptualVerdict): string | null {
  const r = perceptual.rendered;
  if (!r) return null;
  const i = Math.max(0, r.reference.findIndex((v) => v.name === perceptual.worstView));
  const sheet = composeSheet(r.reference[i], r.candidate[i]);
  const canvas = document.createElement('canvas');
  canvas.width = sheet.width; canvas.height = sheet.height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(sheet.rgba.buffer, sheet.rgba.byteOffset, sheet.rgba.byteLength), sheet.width, sheet.height), 0, 0);
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, sheet.width, 20);
  ctx.fillStyle = '#fff'; ctx.font = '12px Helvetica, Arial, sans-serif';
  ['reference', 'result', 'change'].forEach((t, p) => ctx.fillText(t, p * sheet.height + 6, 14));
  return canvas.toDataURL('image/png');
}

async function ingest(
  name: string, bytes: Uint8Array, profile: string, parentId?: string,
  perceptual: PerceptualVerdict | null = null,
): Promise<LocalAsset> {
  if (CONSTRAINED && bytes.byteLength > 120 * 1024 * 1024) {
    throw new Error('This file is too large to process on a mobile device — use a desktop or `npx glbforge ui`.');
  }
  const io = await createIO();
  const doc = await io.readBinary(bytes);
  // The welded-topology pass is O(vertices) with heavy allocation — skip it
  // on constrained devices for large files (the report notes the skip).
  const topology = CONSTRAINED ? bytes.byteLength < 8 * 1024 * 1024 : bytes.byteLength < 40 * 1024 * 1024;
  const report = analyze(doc, {
    profile: getProfile(profile), filePath: name, fileBytes: bytes.byteLength, topology,
  });
  if (perceptual) applyPerceptualVerdict(report, perceptual);
  const fidelitySheet = perceptual ? sheetDataUrl(perceptual) : null;
  const asset: LocalAsset = {
    id: String(nextId++), name, bytes, report, parentId, fidelitySheet,
    blobUrl: URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'model/gltf-binary' })),
  };
  assets.set(asset.id, asset);
  void persistAsset({
    id: asset.id, name, parentId: parentId ?? null, ts: Date.now(),
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    report, fidelitySheet,
  });
  return asset;
}

/** Rehydrate persisted assets (reports included — no re-analysis needed). */
let restored = false;
export async function restorePersisted(): Promise<void> {
  if (restored) return;
  restored = true;
  const rows = (await loadAssets()).sort((a, b) => Number(a.id) - Number(b.id));
  for (const row of rows) {
    const bytes = new Uint8Array(row.bytes);
    assets.set(row.id, {
      id: row.id, name: row.name, bytes,
      report: row.report as LocalAsset['report'],
      parentId: row.parentId ?? undefined,
      fidelitySheet: row.fidelitySheet ?? null,
      blobUrl: URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'model/gltf-binary' })),
    });
    nextId = Math.max(nextId, Number(row.id) + 1);
  }
}

/** Decode any browser-supported image (incl. SVG) to capped RGBA pixels. */
async function decodeImage(bytes: ArrayBuffer, name: string): Promise<{
  px: Uint8Array; width: number; height: number; pngBytes: Uint8Array;
}> {
  const mime = name.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : '';
  const url = URL.createObjectURL(new Blob([bytes], mime ? { type: mime } : undefined));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(`Could not decode ${name}`));
      image.src = url;
    });
    const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight, 1));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0, width, height);
    const px = new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer);
    const pngBlob: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png encode failed'))), 'image/png'));
    return { px, width, height, pngBytes: new Uint8Array(await pngBlob.arrayBuffer()) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** USDZ needs PNG/JPEG textures; transcode WebP (or anything) through a canvas. */
const canvasUsdzEncoder: UsdzTextureEncoder = async ({ bytes, mimeType }, { format }) => {
  if (mimeType === 'image/ktx2') throw new Error('USDZ cannot carry KTX2 textures — export the WebP variant.');
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('texture decode failed'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext('2d')!.drawImage(image, 0, 0);
    const type = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, 0.9));
    if (!blob) throw new Error('texture encode failed');
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png' };
  } finally {
    URL.revokeObjectURL(url);
  }
};

/** Canvas-based texture decoder for the verification renders (≤512px). */
const canvasDecoder: TextureDecoder = async (bytes, mimeType) => {
  if (mimeType === 'image/ktx2') return null;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('texture decode failed'));
      image.src = url;
    });
    const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight, 1));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0, width, height);
    return { rgba: new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer), width, height };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
};

/** Canvas-based texture recompressor (WebP where supported, else JPEG/PNG). */
const canvasEncoder: TextureEncoder = async ({ bytes, mimeType, slots }, { maxSize }) => {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('texture decode failed'));
      image.src = url;
    });
    const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight, 1));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    if (scale === 1 && mimeType === 'image/webp') return null; // nothing to gain
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d')!.drawImage(image, 0, 0, width, height);
    const isNormal = slots.some((s) => /normal/i.test(s));
    // Safari can't encode WebP; detect by output type.
    const tryTypes = isNormal ? ['image/webp', 'image/png'] : ['image/webp', 'image/jpeg'];
    for (const type of tryTypes) {
      const blob: Blob | null = await new Promise((resolve) =>
        canvas.toBlob((b) => resolve(b), type, isNormal ? 0.95 : 0.82));
      if (blob && blob.type === type) {
        return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: type };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
};

export const localEngine = {
  profiles: async () => PROFILES as unknown as Record<string, unknown>,
  list: async (): Promise<AssetSummary[]> => [...assets.values()].map(toDetail),
  get: async (id: string): Promise<AssetDetail> => {
    const a = assets.get(id);
    if (!a) throw new Error('no such asset');
    return toDetail(a);
  },
  fileUrl: (id: string): string => assets.get(id)?.blobUrl ?? '',

  upload: async (name: string, bytes: ArrayBuffer, profile: string) =>
    toDetail(await ingest(name, new Uint8Array(bytes), profile)),

  extrude: async (name: string, bytes: ArrayBuffer, opts: {
    bevel: number; profile: string; layers?: number; pillow?: number; emboss?: number; preset?: string;
  }) => {
    const { px, width, height, pngBytes } = await decodeImage(bytes, name);
    const { doc } = await extrudeFromRgba(px, width, height, {
      bevel: opts.bevel, layers: opts.layers, pillow: opts.pillow, emboss: opts.emboss,
      preset: opts.preset as 'enamel' | undefined,
      textureBytes: { bytes: pngBytes, mimeType: 'image/png' },
    });
    const io = await createIO();
    const out = await io.writeBinary(doc);
    return toDetail(await ingest(name.replace(/\.[a-z0-9]+$/i, '') + '.glb', out, opts.profile));
  },

  optimize: async (id: string, opts: { profile: string; ktx2: boolean }) => {
    if (opts.ktx2) {
      throw new Error('KTX2 encoding needs local CLIs — run `npx glbforge ui` for the full pipeline.');
    }
    const asset = assets.get(id);
    if (!asset) throw new Error('no such asset');
    const io = await createIO();
    const doc = await io.readBinary(asset.bytes);
    // Perceptual verification renders the 2M-tri input four times in JS;
    // skip it for big files on constrained devices (the report notes nothing
    // then — no verdict is better than a stalled tab).
    const verify = CONSTRAINED ? asset.bytes.byteLength < 8 * 1024 * 1024 : true;
    const result = await optimize(doc, {
      profile: getProfile(opts.profile), textureEncoder: canvasEncoder,
      verify, textureDecoder: canvasDecoder, keepViews: true,
    });
    const out = await io.writeBinary(doc);
    return toDetail(await ingest(asset.name.replace(/\.glb$/i, '') + '.web.glb', out, opts.profile, asset.id, result.perceptual));
  },

  reanalyze: async (id: string, profile: string) => {
    const asset = assets.get(id);
    if (!asset) throw new Error('no such asset');
    const io = await createIO();
    const doc = await io.readBinary(asset.bytes);
    asset.report = analyze(doc, {
      profile: getProfile(profile), filePath: asset.name, fileBytes: asset.bytes.byteLength,
    });
    return toDetail(asset);
  },

  stlBlob: async (id: string, sizeMm: number): Promise<Blob> => {
    const asset = assets.get(id);
    if (!asset) throw new Error('no such asset');
    const io = await createIO();
    const doc = await io.readBinary(asset.bytes);
    const { stl } = toStl(doc, { targetSizeMm: sizeMm });
    return new Blob([stl as BlobPart], { type: 'application/octet-stream' });
  },

  usdzBlob: async (id: string, jpeg: boolean): Promise<Blob> => {
    const asset = assets.get(id);
    if (!asset) throw new Error('no such asset');
    const io = await createIO();
    const doc = await io.readBinary(asset.bytes);
    const { usdz } = await toUsdz(doc, { textureEncoder: canvasUsdzEncoder, colorFormat: jpeg ? 'jpeg' : 'png' });
    return new Blob([usdz as BlobPart], { type: 'model/vnd.usdz+zip' });
  },

  glbBlob: async (id: string): Promise<Blob> => {
    const asset = assets.get(id);
    if (!asset) throw new Error('no such asset');
    return new Blob([asset.bytes as BlobPart], { type: 'model/gltf-binary' });
  },
};
