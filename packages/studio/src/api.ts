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

async function check<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? res.statusText);
  }
  return res.json();
}

export const api = {
  profiles: () => fetch('/api/profiles').then((r) => check<Record<string, unknown>>(r)),
  list: () => fetch('/api/assets').then((r) => check<AssetSummary[]>(r)),
  get: (id: string) => fetch(`/api/assets/${id}`).then((r) => check<AssetDetail>(r)),
  fileUrl: (id: string) => `/api/assets/${id}/file`,
  stlUrl: (id: string, size = 80) => `/api/assets/${id}/stl?size=${size}`,

  upload: (name: string, bytes: ArrayBuffer, profile: string) =>
    fetch(`/api/assets?name=${encodeURIComponent(name)}&profile=${profile}`, {
      method: 'POST', body: bytes, headers: OCTET,
    }).then((r) => check<AssetDetail>(r)),

  extrude: (name: string, bytes: ArrayBuffer, opts: { bevel: number; profile: string; layers?: number }) =>
    fetch(`/api/extrude?name=${encodeURIComponent(name)}&bevel=${opts.bevel}&profile=${opts.profile}${opts.layers ? `&layers=${opts.layers}` : ''}`, {
      method: 'POST', body: bytes, headers: OCTET,
    }).then((r) => check<AssetDetail>(r)),

  optimize: (id: string, opts: { profile: string; ktx2: boolean }) =>
    fetch(`/api/assets/${id}/optimize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    }).then((r) => check<AssetDetail>(r)),

  reanalyze: (id: string, profile: string) =>
    fetch(`/api/assets/${id}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    }).then((r) => check<AssetDetail>(r)),

  meshyAvailable: () => fetch('/api/meshy/available').then((r) => check<{ available: boolean }>(r)),
  meshyImage: (bytes: ArrayBuffer, mime: string, pbr: boolean) =>
    fetch(`/api/meshy/image?mime=${encodeURIComponent(mime)}&pbr=${pbr}`, {
      method: 'POST', body: bytes, headers: OCTET,
    }).then((r) => check<{ taskId: string; kind: string }>(r)),
  meshyTask: (kind: string, id: string) =>
    fetch(`/api/meshy/tasks/${kind}/${id}`).then((r) => check<{ status: string; progress: number; error: string | null }>(r)),
  meshyImport: (kind: string, id: string) =>
    fetch(`/api/meshy/tasks/${kind}/${id}/import`, { method: 'POST' }).then((r) => check<AssetDetail>(r)),
};
