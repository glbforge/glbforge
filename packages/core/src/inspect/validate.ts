/**
 * validate: does it open, which format, USDZ packaging compliance, layer
 * metadata, schema errors, AR Quick Look (ARKit) compatibility. Quick mode
 * runs no renders and no topology passes.
 */
import { diag, sortDiagnostics, type Diagnostic } from './diagnostics.js';
import type { SceneIR } from './ir.js';
import type { UsdzContainer } from '../usd-read/usdz-read.js';
import type { UsdLayerData } from '../usd-read/types.js';

export interface ValidationReport {
  opens: boolean;
  format: SceneIR['format'];
  crate_version: string | null;
  usdz_spec_compliant: boolean | null;
  usdz_violations: string[];
  schema_errors: Diagnostic[];
  default_prim: string | null;
  up_axis: 'Y' | 'Z';
  meters_per_unit: number;
  layer_stack: string[];
  arkit_compatible: boolean;
  arkit_issues: Diagnostic[];
  prim_count: number;
  extensions_required: string[];
  diagnostics: Diagnostic[];
}

const SCHEMA_CODES = new Set(['USD_SCHEMA_ERROR', 'MESH_INDEX_OUT_OF_RANGE', 'GLTF_VERSION_UNSUPPORTED', 'EXTENSION_UNSUPPORTED', 'BUFFER_UNRESOLVED', 'DEFAULT_PRIM_NOT_FOUND']);
const ARKIT_PRIM_TYPES = new Set([null, '', 'Xform', 'Scope', 'Mesh', 'Material', 'Shader', 'NodeGraph', 'Skeleton', 'SkelRoot', 'SkelAnimation', 'BlendShape', 'GeomSubset',
  'Cube', 'Sphere', 'Cylinder', 'Cone', 'Capsule', 'Plane', 'PointInstancer', 'Camera', 'Preliminary_AnchoringAPI', 'Preliminary_Behavior', 'Preliminary_Trigger', 'Preliminary_Action']);
const ARKIT_TEXTURE_MIMES = new Set(['image/png', 'image/jpeg']);

export function validateScene(ir: SceneIR, extra: { container?: UsdzContainer | null; layer?: UsdLayerData | null } = {}): ValidationReport {
  const diagnostics: Diagnostic[] = [...ir.diagnostics];
  const isUsd = ir.format.startsWith('usd');
  const rootPath = isUsd ? ir.defaultPrim ?? '/' : '/Asset';

  // --- ARKit / AR Quick Look compatibility ---
  const arkit: Diagnostic[] = [];
  if (isUsd) {
    for (const p of ir.prims) {
      if (!ARKIT_PRIM_TYPES.has(p.type)) arkit.push(diag('PRIM_TYPE_UNSUPPORTED_ARKIT', p.path, `${p.path} is a ${p.type}; AR Quick Look does not render it.`, { data: { type: p.type } }));
    }
    for (const m of ir.materials) {
      if (m.shaderType !== 'UsdPreviewSurface') arkit.push(diag('SHADER_NOT_PREVIEWSURFACE', m.path, `Material "${m.name}" surface shader is ${m.shaderType === 'none' ? 'not connected' : m.shaderType}.`, { property: 'outputs:surface', data: { shader: m.shaderType } }));
    }
  }
  for (const t of ir.textures) {
    if (!t.resolved) continue;
    if (t.mimeType && !ARKIT_TEXTURE_MIMES.has(t.mimeType)) {
      const transcodable = t.mimeType === 'image/webp';
      arkit.push(diag('TEXTURE_FORMAT_UNSUPPORTED', t.path, `Texture "${t.name}" is ${t.mimeType}; USDZ / AR Quick Look accept PNG and JPEG only${transcodable ? ' (export_usdz transcodes WebP automatically)' : ''}.`, { severity: transcodable ? 'info' : 'warning', data: { format: t.mimeType } }));
    }
  }
  for (const m of ir.materials) {
    const feats = m.unsupportedFeatures.filter((f) => !isUsd || f !== m.shaderType);
    if (feats.length) arkit.push(diag('MATERIAL_FEATURE_UNSUPPORTED', m.path, `Material "${m.name}" uses ${feats.join(', ')}; UsdPreviewSurface cannot represent it.`, { data: { features: feats } }));
  }
  for (const mesh of ir.meshes) {
    if (mesh.influences > 4) arkit.push(diag('SKIN_TOO_MANY_INFLUENCES', mesh.path, `${mesh.path} has ${mesh.influences} joint influences per vertex; USDZ export keeps 4.`, { data: { influences: mesh.influences } }));
  }
  if (!isUsd) {
    if (ir.animations.length > 1) arkit.push(diag('CLIPS_DROPPED', ir.animations[1].path, `${ir.animations.length} animation clips; USDZ export carries only the first ("${ir.animations[0].name}").`, { severity: 'info', data: { clips: ir.animations.map((a) => a.name) } }));
    const skinnedNodes = new Set(ir.meshes.filter((m) => m.skin !== null).map((m) => m.node));
    const jointNodes = new Set(ir.skins.flatMap((s) => s.joints));
    for (const a of ir.animations) {
      const dropped = a.channels.filter((c) => c.property !== 'weights' && !jointNodes.has(c.node) && !skinnedNodes.has(c.node));
      if (dropped.length) arkit.push(diag('NODE_ANIMATION_DROPPED', ir.nodes[dropped[0].node].path, `Clip "${a.name}" animates ${new Set(dropped.map((c) => ir.nodes[c.node].path)).size} non-joint node(s); USDZ export (UsdSkel) carries joint animation only.`, { severity: 'info', data: { nodes: [...new Set(dropped.map((c) => ir.nodes[c.node].path))] } }));
    }
  }
  for (const d of diagnostics) {
    if (d.code === 'SUBDIVISION_UNSUPPORTED' || d.code === 'UP_AXIS_Z' || d.code === 'METERS_PER_UNIT_NONSTANDARD' || d.code === 'TEXTURE_UNRESOLVED') arkit.push(d);
  }
  for (const t of ir.textures) if (!t.resolved && !arkit.some((d) => d.code === 'TEXTURE_UNRESOLVED' && d.prim_path === t.path)) arkit.push(diag('TEXTURE_UNRESOLVED', t.path, `Texture "${t.uri ?? t.name}" could not be resolved.`, { property: 'inputs:file' }));
  for (const d of arkit) if (!diagnostics.includes(d)) diagnostics.push(d);

  const schema = diagnostics.filter((d) => SCHEMA_CODES.has(d.code) && d.severity !== 'info');
  const opens = !schema.some((d) => d.severity === 'error') && !diagnostics.some((d) => d.code === 'BUFFER_UNRESOLVED' || d.code === 'USDZ_ARCHIVE_INVALID');
  const arkitFatal = arkit.filter((d) => d.severity !== 'info');
  return {
    opens,
    format: ir.format,
    crate_version: extra.layer?.crateVersion ?? null,
    usdz_spec_compliant: extra.container ? extra.container.specCompliant : ir.format === 'usdz' ? false : null,
    usdz_violations: extra.container?.violations ?? [],
    schema_errors: schema,
    default_prim: ir.defaultPrim,
    up_axis: ir.upAxis,
    meters_per_unit: ir.metersPerUnit,
    layer_stack: ir.layerStack,
    arkit_compatible: arkitFatal.length === 0 && opens,
    arkit_issues: arkit,
    prim_count: ir.primCount,
    extensions_required: ir.extensions.required,
    diagnostics: sortDiagnostics(diagnostics),
  };
}

export { rootPathOf };
function rootPathOf(ir: SceneIR): string { return ir.format.startsWith('usd') ? ir.defaultPrim ?? '/' : '/Asset'; }
