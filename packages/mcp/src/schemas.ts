/**
 * Zod output schemas for every tool. They are registered as MCP
 * `outputSchema`s (so clients can validate `structuredContent`) and
 * exported to schemas/*.json by scripts/emit-schemas.ts.
 */
import { z } from 'zod';
import { ERROR_CODES } from '@glbforge/core';

const codes = Object.keys(ERROR_CODES) as [string, ...string[]];

export const DiagnosticSchema = z.object({
  code: z.enum(codes).describe('Stable, enumerable code — branch on this, not on message text'),
  severity: z.enum(['error', 'warning', 'info']).describe('error = fatal / will not load; warning = loads but likely wrong (or changed without being asked); info = advisory'),
  prim_path: z.string().describe('USD prim path, or the derived path for glTF objects (/Asset/<Node>_<i>/Prim_<j>, /Asset/Materials/…); "" for file-level'),
  property: z.string().optional().describe('Property / attribute the issue concerns'),
  message: z.string(),
  suggested_fix: z.string().optional().describe('Concrete next step, naming the tool call when one fixes it'),
  data: z.record(z.unknown()).optional(),
}).describe('One diagnostic');

/** Envelope shape shared by every tool; `data` is tool-specific. */
export const envelopeShape = <T extends z.ZodTypeAny>(data: T) => ({
  ok: z.boolean().describe('false only when the tool could not run; an asset with errors in it is still ok:true'),
  summary: z.string().describe('One line, human-readable'),
  duration_ms: z.number().int().nonnegative(),
  errors: z.array(DiagnosticSchema).describe('Every diagnostic (error, warning, info), errors first'),
  data: data.or(z.object({}).strict().describe('Empty when ok is false')),
});

export const envelopeSchema = <T extends z.ZodTypeAny>(data: T) => z.object(envelopeShape(data));

// ---------------------------------------------------------------- shared
const vec3 = z.array(z.number()).length(3);
export const BoundingBoxSchema = z.object({ min: vec3, max: vec3, size: vec3 });
export const CameraSchema = z.object({ position: vec3, target: vec3, fov: z.number().describe('Vertical field of view, degrees') });
export const DiffSchema = z.object({
  added_prims: z.array(z.string()),
  removed_prims: z.array(z.string()),
  changed_properties: z.array(z.object({ prim_path: z.string(), property: z.string(), before: z.unknown(), after: z.unknown() })),
  summary: z.string(),
});

export const ValidationDataSchema = z.object({
  path: z.string(),
  mode: z.enum(['quick', 'full']),
  opens: z.boolean(),
  format: z.enum(['glb', 'gltf', 'usdz', 'usda', 'usdc']),
  crate_version: z.string().nullable(),
  usdz_spec_compliant: z.boolean().nullable().describe('null for non-usdz inputs'),
  usdz_violations: z.array(z.string()),
  schema_errors: z.array(DiagnosticSchema),
  default_prim: z.string().nullable(),
  up_axis: z.enum(['Y', 'Z']),
  meters_per_unit: z.number(),
  layer_stack: z.array(z.string()).describe('Root layer plus every declared composition arc (not resolved)'),
  arkit_compatible: z.boolean(),
  arkit_issues: z.array(DiagnosticSchema),
  prim_count: z.number().int(),
  extensions_required: z.array(z.string()),
  sha256: z.string(),
  performance: z.unknown().optional().describe('mode=full: the analyze_performance data'),
  render: z.object({ camera: CameraSchema, size: z.number().int() }).optional().describe('mode=full: the default render (image attached)'),
});

const MeshGeometrySchema = z.object({
  prim_path: z.string(), name: z.string(), node_index: z.number().int(), mesh_index: z.number().int(), primitive_index: z.number().int(),
  mode: z.enum(['triangles', 'points', 'lines', 'other']),
  vertex_count: z.number().int(), face_count: z.number().int(), triangle_count: z.number().int(),
  is_manifold: z.boolean().nullable(), is_closed: z.boolean().nullable(),
  non_manifold_edge_count: z.number().int().nullable(), boundary_edge_count: z.number().int().nullable(), degenerate_face_count: z.number().int().nullable(),
  normals: z.enum(['authored', 'generated', 'missing']), inverted_normal_face_count: z.number().int(),
  uv_sets: z.array(z.object({ name: z.string(), out_of_range: z.boolean(), min: z.array(z.number()), max: z.array(z.number()) })),
  bounding_box: BoundingBoxSchema.nullable().describe('World space, metres'),
  material_path: z.string().nullable(), skin_path: z.string().nullable(), morph_target_count: z.number().int(),
});

export const GeometryDataSchema = z.object({
  path: z.string(),
  meshes: z.array(MeshGeometrySchema),
  mesh_count: z.number().int(), total_triangles: z.number().int(), total_vertices: z.number().int(),
  world_bounding_box: BoundingBoxSchema.nullable(), largest_dimension_m: z.number().nullable(),
  pivot_position: vec3, pivot_in_bounds: z.array(z.number()).nullable().describe('Where the origin sits inside the bounds per axis: 0 = min, 0.5 = centre, 1 = max'),
  pivot_at_base: z.boolean().nullable(), up_axis: z.enum(['Y', 'Z']), meters_per_unit: z.number(),
  scale_warnings: z.array(z.string()),
});

export const AnimationDataSchema = z.object({
  path: z.string(),
  has_animation: z.boolean(),
  time_code_range: z.tuple([z.number(), z.number()]).nullable(),
  time_unit: z.enum(['seconds', 'timecodes']),
  frames_per_second: z.number().nullable(),
  duration_seconds: z.number(),
  clips: z.array(z.object({ prim_path: z.string(), name: z.string(), start: z.number(), end: z.number(), duration_seconds: z.number(), channel_count: z.number().int(), has_motion: z.boolean(), animated_prims: z.array(z.string()) })),
  animated_prims: z.array(z.object({ prim_path: z.string(), properties: z.array(z.string()), clips: z.array(z.string()) })),
  skeletons: z.array(z.object({ prim_path: z.string(), name: z.string(), joint_count: z.number().int(), root_joint_path: z.string().nullable(), bound_meshes: z.array(z.string()), max_influences_per_vertex: z.number().int(), unbound_vertex_count: z.number().int(), animated: z.boolean() })),
  blend_shapes: z.array(z.object({ name: z.string(), prim_path: z.string(), target_mesh: z.string(), is_driven: z.boolean(), default_weight: z.number() })),
  root_motion_detected: z.boolean(),
});

export const MaterialsDataSchema = z.object({
  path: z.string(),
  materials: z.array(z.object({
    prim_path: z.string(), name: z.string(), shader_type: z.string(), bound_meshes: z.array(z.string()),
    inputs: z.array(z.object({ input: z.string(), texture: z.string(), channel: z.string(), color_space: z.string(), tex_coord: z.number().int() })),
    alpha_mode: z.string(), double_sided: z.boolean(), unsupported_features: z.array(z.string()),
  })),
  unbound_meshes: z.array(z.string()),
  textures: z.array(z.object({
    prim_path: z.string(), name: z.string(), path: z.string(), resolved: z.boolean(), resolution: z.tuple([z.number().int(), z.number().int()]).nullable(),
    format: z.string().nullable(), size_bytes: z.number().int(), channel: z.string(), color_space: z.string(),
    used_by: z.array(z.object({ material: z.string(), input: z.string(), channel: z.string() })), memory_estimate_mb: z.number(), is_power_of_two: z.boolean().nullable(),
  })),
  missing_textures: z.array(z.object({ texture: z.string(), path: z.string(), material: z.string(), input: z.string() })),
  texture_memory_estimate_mb: z.number(),
  non_power_of_two: z.array(z.string()),
  oversized: z.array(z.string()),
  oversized_threshold: z.number().int(),
});

export const PerformanceDataSchema = z.object({
  path: z.string(),
  total_triangles: z.number().int(), total_vertices: z.number().int(), draw_call_estimate: z.number().int(),
  material_count: z.number().int(), texture_count: z.number().int(), file_size_bytes: z.number().int(),
  estimated_gpu_memory_mb: z.number(), gpu_memory_breakdown_mb: z.object({ textures: z.number(), geometry: z.number() }),
  texture_bytes: z.number().int(), largest_texture_px: z.number().int(),
  prim_count: z.number().int(), scene_graph_depth: z.number().int(), animation_seconds: z.number(),
  instancing_candidates: z.array(z.object({ prims: z.array(z.string()), copies: z.number().int(), triangle_count: z.number().int() })),
  budget_check: z.object({
    profile: z.string(), pass: z.boolean(),
    overages: z.array(z.object({ metric: z.string(), value: z.number(), limit: z.number(), worst_offender_prim_path: z.string() })),
  }),
  profile_limits: z.record(z.unknown()).describe('The limits that were applied'),
});

export const RenderDataSchema = z.object({
  path: z.string(),
  view: z.enum(['front', 'turntable', 'custom', 'thumbnail']),
  camera: CameraSchema.describe('The camera of the (first) view — what the image shows'),
  cameras: z.array(z.object({ name: z.string(), camera: CameraSchema })).describe('Every tile of a contact sheet, row-major'),
  size: z.number().int().describe('Pixels per tile'),
  width: z.number().int(), height: z.number().int(),
  columns: z.number().int(),
  frame: z.number().nullable().describe('Animation time rendered, seconds (null = rest pose)'),
  triangles: z.number().int(),
  out: z.string().optional(),
});

export const AnimationStripDataSchema = z.object({
  path: z.string(),
  frames: z.array(z.object({ frame: z.number(), time_seconds: z.number(), label: z.string() })),
  fps: z.number(),
  clip: z.object({ index: z.number().int(), name: z.string(), duration_seconds: z.number() }).nullable(),
  camera: CameraSchema,
  size: z.number().int(), width: z.number().int(), height: z.number().int(), columns: z.number().int(),
  out: z.string().optional(),
  clip_file: z.string().nullable().describe('Animated GIF path when include_clip=true'),
});

export const InspectAllDataSchema = z.object({
  path: z.string(),
  validation: ValidationDataSchema.omit({ path: true, mode: true, sha256: true }),
  geometry: GeometryDataSchema.omit({ path: true }),
  animation: AnimationDataSchema.omit({ path: true }),
  materials: MaterialsDataSchema.omit({ path: true }),
  performance: PerformanceDataSchema.omit({ path: true }),
  sha256: z.string(),
});

/** Mutating tools add these fields to their existing payloads. */
export const MutationShape = {
  dry_run: z.boolean(),
  written: z.boolean(),
  diff: DiffSchema,
  post_validation: z.unknown().describe('validate(mode=quick) of the output (null when the output format cannot be validated)'),
};

/** Loose schemas for the pre-existing tool payloads: their fields are unchanged and additive. */
const loose = (shape: z.ZodRawShape) => z.object(shape).passthrough();

export const LegacyDataSchemas = {
  capabilities: loose({ versions: z.record(z.string()), generation: z.unknown(), ktx2: z.unknown(), profiles: z.array(z.string()) }),
  compare_glb: loose({ reference: z.string(), candidate: z.string(), visual: z.unknown() }),
  list_profiles: loose({ profiles: z.array(z.unknown()) }),
  analyze_glb: loose({ file: z.string().nullable(), score: z.number(), passed: z.boolean(), triangles: z.number(), sha256: z.string() }),
  inspect_report: loose({ file: z.unknown() }),
  render_preview: loose({ path: z.string(), views: z.array(z.string()), width: z.number(), height: z.number(), camera: CameraSchema, cameras: z.array(z.object({ name: z.string(), camera: CameraSchema })) }),
  ship_asset: loose({}),
  audit_directory: loose({ scanned: z.number(), failing: z.array(z.string()) }),
  optimize_glb: loose({ outPath: z.string(), sha256: z.string().nullable(), steps: z.array(z.string()), ...MutationShape }),
  extrude_image: loose({ out: z.string(), ...MutationShape }),
  export_stl: loose({ out: z.string(), ...MutationShape }),
  export_usdz: loose({ out: z.string(), ...MutationShape }),
  generate_image_to_3d: loose({ requestId: z.string(), model: z.string() }),
  generation_status: loose({ status: z.string() }),
  meshy_create_task: loose({ taskId: z.string(), kind: z.string() }),
  meshy_task_status: loose({ id: z.string(), status: z.string() }),
  meshy_download: loose({ out: z.string() }),
} as const;

export const ToolDataSchemas = {
  validate: ValidationDataSchema,
  inspect_geometry: GeometryDataSchema,
  inspect_animation: AnimationDataSchema,
  inspect_materials: MaterialsDataSchema,
  analyze_performance: PerformanceDataSchema,
  render: RenderDataSchema,
  render_animation_strip: AnimationStripDataSchema,
  inspect_all: InspectAllDataSchema,
  ...LegacyDataSchemas,
} as const;

export type ToolName = keyof typeof ToolDataSchemas;
