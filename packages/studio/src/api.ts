/** Thin client for the `glbforge ui` local API. */

export interface AssetSummary {
  id: string;
  name: string;
  bytes: number;
  score: number;
  passed: boolean;
  triangles: number;
  parentId: string | null;
  steps: string[] | null;
}

export interface Finding {
  ruleId: string;
  severity: 'error' | 'warn' | 'info';
  message: string;
  data?: Record<string, unknown>;
  suggestion?: string;
}

export interface Report {
  score: number;
  passed: boolean;
  profile: { name: string; maxTriangles: number; maxDrawCalls: number; maxTextureBytes: number; maxTextureVramBytes: number; maxFileBytes: number; maxMaterials: number };
  file: { bytes: number };
  geometry: {
    triangles: number; vertices: number; drawCallEstimate: number;
    primsMissingNormals: number;
    topology: { boundaryEdges: number; nonManifoldEdges: number } | null;
  };
  textures: Array<{ name: string; width: number | null; height: number | null; mimeType: string; bytes: number }>;
  textureBytesTotal: number;
  textureVramTotal: number;
  materials: unknown[];
  findings: Finding[];
}

/** What the forge decided, for assets it made. Absent on everything else. */
export interface ForgeNote {
  /** 'alpha' | 'luma' | 'matte' — where the silhouette came from. */
  mode: string;
  /** Set when a subject was lifted: how separable it was, and why. */
  matte?: {
    confidence: number; coverage: number; components: number; holes: number;
    version: string; notes: string[];
  };
  /** Set when layers: 'auto' ran — the measurement behind layering or not. */
  flatness?: { coverage: number; distinct: number; layers: number };
  /** How many colour layers were actually built. */
  layers: number;
}

export type AssetDetail = AssetSummary & {
  report: Report;
  /** reference | result | change-heatmap sheet (PNG URL or data URL), set on optimized variants. */
  fidelitySheet?: string | null;
  forge?: ForgeNote;
};

// Browsers send no Content-Type for ArrayBuffer bodies; Express's raw
// parser needs one to engage.
const OCTET = { 'Content-Type': 'application/octet-stream' };

/**
 * Backend detection: served by `glbforge ui` -> remote Express API; served
 * statically (glbforge.dev/studio) -> everything runs in this browser via
 * the local engine. Resolved once at boot by probing /api/profiles.
 */
export type Backend = 'remote' | 'local';
let backend: Backend = 'remote';
export const getBackend = (): Backend => backend;

export async function detectBackend(): Promise<Backend> {
  try {
    const res = await fetch('/api/profiles', { signal: AbortSignal.timeout(2500) });
    backend = res.ok ? 'remote' : 'local';
  } catch {
    backend = 'local';
  }
  return backend;
}

const local = () => import('./local-engine').then((m) => m.localEngine);
export const restoreLocal = () =>
  import('./local-engine').then((m) => m.restorePersisted());

async function check<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? res.statusText);
  }
  return res.json();
}

export const api = {
  profiles: async () => backend === 'local'
    ? (await local()).profiles()
    : fetch('/api/profiles').then((r) => check<Record<string, unknown>>(r)),
  list: async () => backend === 'local'
    ? (await local()).list()
    : fetch('/api/assets').then((r) => check<AssetSummary[]>(r)),
  get: async (id: string) => backend === 'local'
    ? (await local()).get(id)
    : fetch(`/api/assets/${id}`).then((r) => check<AssetDetail>(r)),
  fileUrl: (id: string) => backend === 'local'
    ? localFileUrl(id)
    : `/api/assets/${id}/file`,

  /** Download helpers work in both modes (blob in local, fetch in remote). */
  downloadStl: async (id: string, name: string, size = 80) => {
    const blob = backend === 'local'
      ? await (await local()).stlBlob(id, size)
      : await fetch(`/api/assets/${id}/stl?size=${size}`).then((r) => r.blob());
    triggerDownload(blob, derivedName(name, 'stl'));
  },
  /** Save the USDZ as a file (iOS Safari puts it in Files › Downloads). */
  downloadUsdz: async (id: string, name: string, jpeg = true) => {
    triggerDownload(await usdzBlob(id, jpeg), derivedName(name, 'usdz'));
  },
  /**
   * iOS only: open the USDZ in AR Quick Look. Quick Look's own share button
   * re-shares the URL it was opened with, and a blob URL has no file behind
   * it, so this is the *view* path — `downloadUsdz` is the one that keeps a
   * copy. The build is cached between the two so the second tap is instant.
   */
  viewUsdzInAr: async (id: string, jpeg = true) => {
    openInQuickLook(await usdzBlob(id, jpeg));
  },
  downloadGlb: async (id: string, name: string) => {
    const blob = backend === 'local'
      ? await (await local()).glbBlob(id)
      : await fetch(`/api/assets/${id}/file`).then((r) => r.blob());
    triggerDownload(blob, derivedName(name, 'glb'));
  },

  upload: async (name: string, bytes: ArrayBuffer, profile: string) =>
    backend === 'local'
      ? (await local()).upload(name, bytes, profile)
      : fetch(`/api/assets?name=${encodeURIComponent(name)}&profile=${profile}`, {
          method: 'POST', body: bytes, headers: OCTET,
        }).then((r) => check<AssetDetail>(r)),

  extrude: async (name: string, bytes: ArrayBuffer, opts: { bevel: number; profile: string; layers?: number | 'auto'; pillow?: number; emboss?: number; preset?: string; matte?: 'auto' | 'off'; matteTolerance?: number }) =>
    backend === 'local'
      ? (await local()).extrude(name, bytes, opts)
      : fetch(`/api/extrude?name=${encodeURIComponent(name)}&bevel=${opts.bevel}&profile=${opts.profile}${opts.layers ? `&layers=${opts.layers}` : ''}${opts.pillow ? `&pillow=${opts.pillow}` : ''}${opts.emboss ? `&emboss=${opts.emboss}` : ''}${opts.preset ? `&preset=${opts.preset}` : ''}${opts.matte ? `&matte=${opts.matte}` : ''}${opts.matteTolerance ? `&matteTolerance=${opts.matteTolerance}` : ''}`, {
          method: 'POST', body: bytes, headers: OCTET,
        }).then((r) => check<AssetDetail>(r)),

  optimize: async (id: string, opts: { profile: string; ktx2: boolean }) =>
    backend === 'local'
      ? (await local()).optimize(id, opts)
      : fetch(`/api/assets/${id}/optimize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts),
        }).then((r) => check<AssetDetail>(r)),

  reanalyze: async (id: string, profile: string) =>
    backend === 'local'
      ? (await local()).reanalyze(id, profile)
      : fetch(`/api/assets/${id}/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile }),
        }).then((r) => check<AssetDetail>(r)),

  meshyAvailable: async () => backend === 'local'
    ? { available: false, generators: {} as Record<string, boolean> }
    : fetch('/api/meshy/available').then((r) =>
        check<{ available: boolean; generators?: Record<string, boolean> }>(r)),
  meshyImage: (bytes: ArrayBuffer, mime: string, pbr: boolean, provider = 'meshy') =>
    fetch(`/api/meshy/image?mime=${encodeURIComponent(mime)}&pbr=${pbr}&provider=${provider}`, {
      method: 'POST', body: bytes, headers: OCTET,
    }).then((r) => check<{ taskId: string; kind: string }>(r)),
  meshyTask: (kind: string, id: string) =>
    fetch(`/api/meshy/task2?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`)
      .then((r) => check<{ status: string; progress: number; error: string | null }>(r)),
  meshyImport: (kind: string, id: string) =>
    fetch(`/api/meshy/import2?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`, { method: 'POST' })
      .then((r) => check<AssetDetail>(r)),
};

// Synchronous blob-URL lookup for local mode (the engine registers URLs at
// ingest; this avoids making fileUrl async for the viewport).
let localUrls: ((id: string) => string) | null = null;
export function registerLocalUrls(fn: (id: string) => string): void { localUrls = fn; }
function localFileUrl(id: string): string { return localUrls ? localUrls(id) : ''; }

import type { FileKind } from '@glbforge/core';

/**
 * Name a file derived from an asset. `.web` / `.forge` / `.gen` / `.lodN` are
 * GLBForge's markers on a *GLB*; they are meaningless on an STL and they put a
 * second dot before the extension, which iOS Files and most mail clients read
 * as a double extension. So `cat.web.glb` saves as `cat-web.stl`, never
 * `cat.web.stl`, and `cat.web.lod1.glb` as `cat-web-lod1.glb`.
 */
export function derivedName(name: string, ext: string): string {
  const stem = name.replace(/\.(glb|gltf)$/i, '');
  const flat = stem.replace(
    /\.(web|forge|gen)(?:\.lod(\d+))?$/i,
    (_m, tag: string, lod?: string) => `-${tag.toLowerCase()}${lod ? `-lod${lod}` : ''}`,
  );
  return `${flat}.${ext}`;
}

/** Formats every browser can decode *and* every generator accepts as input. */
const PORTABLE_IMAGE = /^image\/(png|jpeg|webp|svg\+xml)$/;
const PORTABLE_KINDS = new Set<FileKind>(['png', 'jpeg', 'webp', 'svg']);

/**
 * Normalize a picked image. A photo chosen on an iPhone arrives as HEIC —
 * more so since the picker stopped filtering by `accept`, because iOS only
 * transcodes to JPEG when a filter asks it to. Safari decodes HEIC happily,
 * but nothing else does and no generator takes it, so anything outside the
 * portable set is re-encoded to PNG here, once, at the door. Returns the
 * bytes to use and the name to use with them.
 */
export async function normalizeImage(file: File, bytes: ArrayBuffer, kind?: FileKind): Promise<{
  name: string; bytes: ArrayBuffer; mime: string;
}> {
  const mime = file.type || '';
  // The sniffed kind outranks the declared type: a PNG typed
  // `application/octet-stream` needs no re-encoding, and a HEIC typed
  // `image/jpeg` very much does.
  if (kind ? PORTABLE_KINDS.has(kind) : PORTABLE_IMAGE.test(mime)) {
    return { name: file.name, bytes, mime: mime || `image/${kind === 'svg' ? 'svg+xml' : kind}` };
  }
  const url = URL.createObjectURL(new Blob([bytes], mime ? { type: mime } : undefined));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(
        `Could not read ${file.name} as an image (${mime || 'unknown type'}).`));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, image.naturalWidth);
    canvas.height = Math.max(1, image.naturalHeight);
    canvas.getContext('2d')!.drawImage(image, 0, 0);
    const png: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png encode failed'))), 'image/png'));
    return {
      name: file.name.replace(/\.[^.]+$/, '') + '.png',
      bytes: await png.arrayBuffer(),
      mime: 'image/png',
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Touch device: no drag-and-drop, and the OS file picker filters by `accept`.
 * Both matter at the drop zone — see AssetRail.
 */
export const isTouch = (): boolean =>
  typeof navigator !== 'undefined'
  && (navigator.maxTouchPoints > 0 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent));

/** iPhone / iPad (incl. iPadOS desktop UA with touch): AR Quick Look opens USDZ; GLB has no native viewer. */
export const isIOS = (): boolean =>
  typeof navigator !== 'undefined' && (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

/**
 * One USDZ build shared by the AR and save paths — building it takes seconds,
 * and on iOS the two buttons are the expected sequence (look at it, then keep
 * it). Only the most recent asset is held, since the blob is megabytes.
 */
let usdzCache: { key: string; blob: Blob } | null = null;
async function usdzBlob(id: string, jpeg: boolean): Promise<Blob> {
  const key = `${id}:${jpeg}:${backend}`;
  if (usdzCache?.key === key) return usdzCache.blob;
  const blob = backend === 'local'
    ? await (await local()).usdzBlob(id, jpeg)
    : await fetch(`/api/assets/${id}/usdz?jpeg=${jpeg ? 1 : 0}`).then((r) => r.blob());
  usdzCache = { key, blob };
  return blob;
}

/**
 * Hand a USDZ to AR Quick Look instead of saving it. Safari intercepts a click
 * on an `<a rel="ar">` whose only child is an `<img>` and opens the AR viewer
 * in place — the img child is load-bearing (without it the link just
 * navigates), and a `download` attribute would make Safari save the file
 * instead, which is the behaviour this replaces. From the AR view the share
 * sheet still offers "Save to Files", so nothing is lost.
 */
function openInQuickLook(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.rel = 'ar';
  a.href = url;
  a.appendChild(document.createElement('img'));
  document.body.appendChild(a);
  a.click();
  a.remove();
  keepAlive(url);
}

/**
 * A click is not the download. iOS Safari answers one with a confirmation
 * sheet — "Do you want to download …?" — and only fetches the href when the
 * user taps Download, which is easily a minute later. Revoking the object URL
 * on a short timer (it was 5s) pulls the file out from under that tap, and the
 * download fails with nothing to explain it. Desktop browsers start
 * immediately and never noticed. Ten minutes of a retained blob is the cost of
 * the save working; the page drops it on unload regardless.
 */
function keepAlive(url: string): void {
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  // Some iOS versions ignore a click on a detached anchor.
  document.body.appendChild(a);
  a.click();
  a.remove();
  keepAlive(url);
}

// ---------------------------------------------------------------------------
// Cloud client (hosted studio only): auth + metered generation + billing on
// the glbforge.dev edge worker. Independent from the local/remote pipeline —
// generated models are downloaded and ingested into the in-browser engine.
export interface CloudUser { login: string; credits: number }

export const cloud = {
  loginUrl: (provider: 'github' | 'google' = 'github') => `/api/auth/login?provider=${provider}`,
  providers: async (): Promise<{ github: boolean; google: boolean; generators?: Record<string, boolean>; costs?: Record<string, number> }> => {
    try {
      const res = await fetch('/api/auth/providers', { signal: AbortSignal.timeout(4000) });
      return res.ok ? res.json() : { github: false, google: false };
    } catch { return { github: false, google: false }; }
  },
  me: async (): Promise<{ available: boolean; user: CloudUser | null }> => {
    try {
      const res = await fetch('/api/auth/me', { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return { available: false, user: null };
      const data = (await res.json()) as { user: CloudUser | null };
      return { available: true, user: data.user };
    } catch {
      return { available: false, user: null };
    }
  },
  logout: () => fetch('/api/auth/logout', { method: 'POST' }).then(() => undefined),
  genImage: (bytes: ArrayBuffer, mime: string, pbr: boolean, provider = 'meshy') =>
    fetch(`/api/gen/image?mime=${encodeURIComponent(mime)}&pbr=${pbr}&provider=${provider}`, {
      method: 'POST', body: bytes, headers: OCTET,
    }).then((r) => check<{ taskId: string; kind: string; cost?: number }>(r)),
  genTask: (id: string) =>
    fetch(`/api/gen/tasks/${id}`).then((r) => check<{ status: string; progress: number; error: string | null }>(r)),
  history: () =>
    fetch('/api/gen/history').then((r) => check<{ tasks: Array<{ task_id: string; kind: string; created_at: number }> }>(r)),
  genFileBytes: async (id: string): Promise<ArrayBuffer> => {
    const res = await fetch(`/api/gen/tasks/${id}/file`);
    if (!res.ok) throw new Error('model download failed');
    return res.arrayBuffer();
  },
  checkout: async (pack: string): Promise<void> => {
    const { url } = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pack }),
    }).then((r) => check<{ url: string }>(r));
    location.href = url;
  },
};
