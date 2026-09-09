/**
 * Structural diff between two SceneIRs (before / after a mutating tool):
 * prims added and removed, and per-prim property changes an agent cares
 * about (counts, normals, materials, texture size/format, bounds).
 */
import { worldBounds, type SceneIR } from './ir.js';

export interface PropertyChange {
  prim_path: string;
  property: string;
  before: unknown;
  after: unknown;
}

export interface SceneDiff {
  added_prims: string[];
  removed_prims: string[];
  changed_properties: PropertyChange[];
  summary: string;
}

type Props = Record<string, unknown>;

function primProps(ir: SceneIR): Map<string, Props> {
  const out = new Map<string, Props>();
  const round = (v: number) => Math.round(v * 1000) / 1000;
  for (const m of ir.meshes) {
    out.set(m.path, {
      kind: 'mesh',
      triangle_count: m.triangleCount, vertex_count: m.vertexCount,
      normals: m.normalsSource, uv_sets: m.uvs.length, indexed: !!m.indices,
      material: m.material !== null ? ir.materials[m.material]?.path ?? null : null,
      skin: m.skin !== null ? ir.skins[m.skin]?.path ?? null : null,
      morph_targets: m.targets.length, influences: m.influences,
    });
  }
  for (const n of ir.nodes) if (!n.isJoint && !out.has(n.path)) out.set(n.path, { kind: 'node', children: n.children.length, meshes: n.meshes.length, translation: n.translation.map(round) });
  for (const m of ir.materials) out.set(m.path, { kind: 'material', alpha_mode: m.alphaMode, double_sided: m.doubleSided, textures: m.textures.map((u) => `${u.input}:${ir.textures[u.texture]?.path ?? '?'}`).sort(), shader: m.shaderType });
  for (const t of ir.textures) out.set(t.path, { kind: 'texture', resolution: t.width && t.height ? [t.width, t.height] : null, format: t.mimeType, size_bytes: t.bytes, resolved: t.resolved });
  for (const s of ir.skins) out.set(s.path, { kind: 'skin', joints: s.joints.length });
  for (const a of ir.animations) out.set(a.path, { kind: 'animation', channels: a.channels.length, duration: round(a.end - a.start) });
  return out;
}

function sceneProps(ir: SceneIR): Props {
  const bb = worldBounds(ir);
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return {
    file_size_bytes: ir.fileBytes,
    total_triangles: ir.meshes.reduce((s, m) => s + m.triangleCount, 0),
    total_vertices: ir.meshes.reduce((s, m) => s + m.vertexCount, 0),
    draw_calls: ir.meshes.filter((m) => m.triangleCount > 0).length,
    materials: ir.materials.length, textures: ir.textures.length, nodes: ir.nodes.filter((n) => !n.isJoint).length,
    bounding_box_size: bb ? bb.size.map(r) : null,
    up_axis: ir.upAxis, meters_per_unit: ir.metersPerUnit,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A plain, immutable capture of what the differ compares — take it BEFORE mutating a document in place. */
export interface SceneSnapshot { prims: Map<string, Props>; scene: Props; rootPath: string }

export function snapshotScene(ir: SceneIR): SceneSnapshot {
  return { prims: primProps(ir), scene: sceneProps(ir), rootPath: ir.format.startsWith('usd') ? ir.defaultPrim ?? '/' : '/Asset' };
}

const isSnapshot = (x: SceneIR | SceneSnapshot): x is SceneSnapshot => 'prims' in x && x.prims instanceof Map;

export function diffScenes(before: SceneIR | SceneSnapshot, after: SceneIR | SceneSnapshot): SceneDiff {
  const sa0 = isSnapshot(before) ? before : snapshotScene(before);
  const sb0 = isSnapshot(after) ? after : snapshotScene(after);
  const a = sa0.prims, b = sb0.prims;
  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const changed: PropertyChange[] = [];
  for (const [path, pa] of a) {
    const pb = b.get(path);
    if (!pb) continue;
    for (const key of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
      if (key === 'kind' || same(pa[key], pb[key])) continue;
      changed.push({ prim_path: path, property: key, before: pa[key] ?? null, after: pb[key] ?? null });
    }
  }
  const rootPath = sb0.rootPath;
  const sa = sa0.scene, sb = sb0.scene;
  for (const key of Object.keys(sa)) if (!same(sa[key], sb[key])) changed.push({ prim_path: rootPath, property: key, before: sa[key], after: sb[key] });
  const summary = `${added.length} prim(s) added, ${removed.length} removed, ${changed.length} property change(s)`;
  return { added_prims: added, removed_prims: removed, changed_properties: changed, summary };
}
