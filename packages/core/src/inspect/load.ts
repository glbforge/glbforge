/**
 * Node-only loader: a path on disk → SceneIR (+ the underlying document /
 * layer for tools that need them). GLB, glTF (+ external files, with missing
 * images reported instead of thrown), usdz, usda, usdc.
 */
import type { Document } from '@gltf-transform/core';
import { createNodeIO } from '../io.js';
import { diag, type Diagnostic } from './diagnostics.js';
import { fromGltf } from './from-gltf.js';
import { fromUsd } from './from-usd.js';
import type { SceneIR } from './ir.js';
import { readUsdLayer } from '../usd-read/index.js';
import { findUsdzEntry, readUsdz, type UsdzContainer } from '../usd-read/usdz-read.js';
import type { UsdLayerData } from '../usd-read/types.js';

export type SceneFormat = SceneIR['format'];

export interface LoadedScene {
  ir: SceneIR;
  bytes: Uint8Array;
  format: SceneFormat;
  /** gltf-transform document (GLB/glTF only). */
  doc?: Document;
  /** USD layer + container (USD only). */
  usd?: { layer: UsdLayerData; container: UsdzContainer | null };
}

export function formatOf(path: string): SceneFormat | null {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (ext === 'glb') return 'glb';
  if (ext === 'gltf') return 'gltf';
  if (ext === 'usdz') return 'usdz';
  if (ext === 'usda') return 'usda';
  if (ext === 'usdc') return 'usdc';
  if (ext === 'usd') return 'usdc'; // sniffed below
  return null;
}

const KNOWN_EXTENSIONS = new Set([
  'KHR_draco_mesh_compression', 'KHR_lights_punctual', 'KHR_materials_anisotropy', 'KHR_materials_clearcoat', 'KHR_materials_diffuse_transmission',
  'KHR_materials_dispersion', 'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_iridescence', 'KHR_materials_sheen',
  'KHR_materials_specular', 'KHR_materials_transmission', 'KHR_materials_unlit', 'KHR_materials_variants', 'KHR_materials_volume',
  'KHR_mesh_quantization', 'KHR_texture_basisu', 'KHR_texture_transform', 'KHR_xmp_json_ld', 'EXT_mesh_gpu_instancing', 'EXT_meshopt_compression',
  'EXT_texture_webp', 'EXT_texture_avif',
]);

export async function loadScene(path: string): Promise<LoadedScene> {
  const { readFile, stat } = await import('node:fs/promises');
  const { dirname, resolve, basename } = await import('node:path');
  const format = formatOf(path);
  if (!format) throw Object.assign(new Error(`Unsupported file type: ${path} (glb, gltf, usdz, usda, usdc, usd).`), { code: 'FORMAT_UNSUPPORTED' });
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await readFile(path)); } catch (err) { throw Object.assign(new Error(`Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`), { code: 'FILE_NOT_FOUND' }); }
  const diagnostics: Diagnostic[] = [];

  if (format === 'glb' || format === 'gltf') {
    const io = await createNodeIO();
    const { Logger } = await import('@gltf-transform/core');
    let doc: Document;
    const unresolved = new Set<string | number>();
    try {
      if (format === 'glb') {
        doc = await io.readBinary(bytes);
      } else {
        const json = JSON.parse(new TextDecoder().decode(bytes)) as { buffers?: Array<{ uri?: string }>; images?: Array<{ uri?: string }>; extensionsRequired?: string[] };
        for (const ext of json.extensionsRequired ?? []) {
          if (!KNOWN_EXTENSIONS.has(ext)) diagnostics.push(diag('EXTENSION_UNSUPPORTED', '/Asset', `extensionsRequired lists ${ext}, which this toolset (and most loaders) does not implement.`, { property: 'extensionsRequired', data: { extension: ext } }));
        }
        const resources: Record<string, Uint8Array<ArrayBuffer>> = {};
        const dir = dirname(resolve(path));
        const load = async (uri: string, kind: 'buffer' | 'image') => {
          if (uri.startsWith('data:')) return;
          try { resources[uri] = new Uint8Array(await readFile(resolve(dir, decodeURIComponent(uri)))) as Uint8Array<ArrayBuffer>; }
          catch {
            resources[uri] = new Uint8Array(0);
            if (kind === 'buffer') diagnostics.push(diag('BUFFER_UNRESOLVED', '/Asset', `Buffer "${uri}" was not found next to ${basename(path)}.`, { property: 'buffers', data: { uri } }));
            else unresolved.add(uri);
          }
        };
        for (const b of json.buffers ?? []) if (b.uri) await load(b.uri, 'buffer');
        for (const im of json.images ?? []) if (im.uri) await load(im.uri, 'image');
        doc = await io.readJSON({ json: json as never, resources });
      }
    } catch (err) {
      throw Object.assign(new Error(`${basename(path)} could not be parsed as ${format}: ${err instanceof Error ? err.message : String(err)}`), { code: 'FILE_UNREADABLE', diagnostics });
    }
    doc.setLogger(new Logger(Logger.Verbosity.ERROR));
    for (const ext of doc.getRoot().listExtensionsRequired()) {
      if (!KNOWN_EXTENSIONS.has(ext.extensionName)) diagnostics.push(diag('EXTENSION_UNSUPPORTED', '/Asset', `extensionsRequired lists ${ext.extensionName}.`, { property: 'extensionsRequired' }));
    }
    const ir = fromGltf(doc, { format, sourcePath: path, fileBytes: bytes.byteLength, unresolvedTextures: unresolved, diagnostics });
    return { ir, bytes, format, doc };
  }

  // --- USD ---
  let container: UsdzContainer | null = null;
  let layerBytes = bytes;
  let layerName = basename(path);
  let realFormat: SceneFormat = format;
  if (format === 'usdz') {
    container = readUsdz(bytes);
    diagnostics.push(...container.diagnostics);
    if (!container.layer) throw Object.assign(new Error(`${basename(path)} contains no USD layer.`), { code: 'USDZ_NO_LAYER', diagnostics });
    layerBytes = container.layer.data;
    layerName = container.layer.name;
  } else {
    realFormat = new TextDecoder().decode(bytes.subarray(0, 8)) === 'PXR-USDC' ? 'usdc' : 'usda';
  }
  let layer: UsdLayerData;
  try { layer = readUsdLayer(layerBytes); }
  catch (err) { throw Object.assign(new Error(`${layerName} could not be parsed: ${err instanceof Error ? err.message : String(err)}`), { code: 'FILE_UNREADABLE', diagnostics }); }
  for (const w of layer.warnings) diagnostics.push(diag('USD_SCHEMA_ERROR', '/', w, { severity: 'info' }));
  const dir = dirname(resolve(path));
  const { readFileSync, existsSync } = await import('node:fs');
  const resolveAsset = (assetPath: string): Uint8Array | null => {
    if (container) return findUsdzEntry(container, assetPath, layerName)?.data ?? null;
    const full = resolve(dir, assetPath.replace(/^\.\//, ''));
    try { return existsSync(full) ? new Uint8Array(readFileSync(full)) : null; } catch { return null; }
  };
  const ir = fromUsd(layer, { format: realFormat, sourcePath: path, fileBytes: bytes.byteLength, resolveAsset, layerName, diagnostics });
  try { const s = await stat(path); ir.fileBytes = s.size; } catch { /* keep byteLength */ }
  return { ir, bytes, format: realFormat, usd: { layer, container } };
}
