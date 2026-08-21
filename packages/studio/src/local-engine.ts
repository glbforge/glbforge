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
  extrudeFromRgba,
  getProfile,
  optimize,
  PROFILES,
  toStl,
  type AnalysisResult,
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
});

/** Constrained device: coarse pointer / low reported memory / mobile UA. */
const CONSTRAINED =
  typeof navigator !== 'undefined' &&
  (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ||
    ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) <= 4);

async function ingest(
  name: string, bytes: Uint8Array, profile: string, parentId?: string,
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
  const asset: LocalAsset = {
    id: String(nextId++), name, bytes, report, parentId,
    blobUrl: URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'model/gltf-binary' })),
  };
  assets.set(asset.id, asset);
  void persistAsset({
    id: asset.id, name, parentId: parentId ?? null, ts: Date.now(),
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    report,
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
    await optimize(doc, { profile: getProfile(opts.profile), textureEncoder: canvasEncoder });
    const out = await io.writeBinary(doc);
    return toDetail(await ingest(asset.name.replace(/\.glb$/i, '') + '.web.glb', out, opts.profile, asset.id));
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

  glbBlob: async (id: string): Promise<Blob> => {
    const asset = assets.get(id);
    if (!asset) throw new Error('no such asset');
    return new Blob([asset.bytes as BlobPart], { type: 'model/gltf-binary' });
  },
};
