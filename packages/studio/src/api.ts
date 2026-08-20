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

export type AssetDetail = AssetSummary & { report: Report };

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
    triggerDownload(blob, name.replace(/\.glb$/i, '') + '.stl');
  },
  downloadGlb: async (id: string, name: string) => {
    const blob = backend === 'local'
      ? await (await local()).glbBlob(id)
      : await fetch(`/api/assets/${id}/file`).then((r) => r.blob());
    triggerDownload(blob, name);
  },

  upload: async (name: string, bytes: ArrayBuffer, profile: string) =>
    backend === 'local'
      ? (await local()).upload(name, bytes, profile)
      : fetch(`/api/assets?name=${encodeURIComponent(name)}&profile=${profile}`, {
          method: 'POST', body: bytes, headers: OCTET,
        }).then((r) => check<AssetDetail>(r)),

  extrude: async (name: string, bytes: ArrayBuffer, opts: { bevel: number; profile: string; layers?: number; pillow?: number; emboss?: number; preset?: string }) =>
    backend === 'local'
      ? (await local()).extrude(name, bytes, opts)
      : fetch(`/api/extrude?name=${encodeURIComponent(name)}&bevel=${opts.bevel}&profile=${opts.profile}${opts.layers ? `&layers=${opts.layers}` : ''}${opts.pillow ? `&pillow=${opts.pillow}` : ''}${opts.emboss ? `&emboss=${opts.emboss}` : ''}${opts.preset ? `&preset=${opts.preset}` : ''}`, {
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
    ? { available: false }
    : fetch('/api/meshy/available').then((r) => check<{ available: boolean }>(r)),
  meshyImage: (bytes: ArrayBuffer, mime: string, pbr: boolean) =>
    fetch(`/api/meshy/image?mime=${encodeURIComponent(mime)}&pbr=${pbr}`, {
      method: 'POST', body: bytes, headers: OCTET,
    }).then((r) => check<{ taskId: string; kind: string }>(r)),
  meshyTask: (kind: string, id: string) =>
    fetch(`/api/meshy/tasks/${kind}/${id}`).then((r) => check<{ status: string; progress: number; error: string | null }>(r)),
  meshyImport: (kind: string, id: string) =>
    fetch(`/api/meshy/tasks/${kind}/${id}/import`, { method: 'POST' }).then((r) => check<AssetDetail>(r)),
};

// Synchronous blob-URL lookup for local mode (the engine registers URLs at
// ingest; this avoids making fileUrl async for the viewport).
let localUrls: ((id: string) => string) | null = null;
export function registerLocalUrls(fn: (id: string) => string): void { localUrls = fn; }
function localFileUrl(id: string): string { return localUrls ? localUrls(id) : ''; }

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------------------
// Cloud client (hosted studio only): auth + metered generation + billing on
// the glbforge.dev edge worker. Independent from the local/remote pipeline —
// generated models are downloaded and ingested into the in-browser engine.
export interface CloudUser { login: string; credits: number }

export const cloud = {
  loginUrl: (provider: 'github' | 'google' = 'github') => `/api/auth/login?provider=${provider}`,
  providers: async (): Promise<{ github: boolean; google: boolean }> => {
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
  genImage: (bytes: ArrayBuffer, mime: string, pbr: boolean) =>
    fetch(`/api/gen/image?mime=${encodeURIComponent(mime)}&pbr=${pbr}`, {
      method: 'POST', body: bytes, headers: OCTET,
    }).then((r) => check<{ taskId: string; kind: string }>(r)),
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
