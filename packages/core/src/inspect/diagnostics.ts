/**
 * Agent-facing diagnostics: stable, enumerable codes with an explicit
 * severity and the prim path they refer to. Agents branch on `code`, not on
 * message text, and chain inspect → fix → re-validate on `prim_path`.
 *
 * `ERROR_CODES` is the single source of truth: docs/error-codes.md is
 * generated from it (and a test keeps them in sync).
 *
 * Severity contract:
 *   error   — fatal / the asset will not load (or the tool could not run)
 *   warning — loads, but is very likely wrong or was changed without being asked
 *   info    — advisory
 */
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  /** USD prim path, or the derived path for GLB objects (see ir.ts). "" for file-level issues. */
  prim_path: string;
  /** Property / attribute the issue concerns, when it is narrower than the prim. */
  property?: string;
  message: string;
  /** Concrete next step — ideally the tool call that fixes it. */
  suggested_fix?: string;
  /** Rule-specific numbers an agent may want (never required to parse). */
  data?: Record<string, unknown>;
}

interface CodeSpec {
  severity: DiagnosticSeverity;
  meaning: string;
  fix: string;
  /** Slash-namespaced rule id this code is the alias of (public API; see packs/). */
  rule?: string;
}

const spec = (severity: DiagnosticSeverity, meaning: string, fix: string, rule?: string): CodeSpec => ({ severity, meaning, fix, ...(rule ? { rule } : {}) });

/** Every code the toolset can emit. Grouped by the tool that usually raises it. */
export const ERROR_CODES = {
  // --- file / container (validate) -----------------------------------------
  FILE_NOT_FOUND: spec('error', 'The path does not exist or is not readable.', 'Check the absolute path; use audit_directory to list assets.'),
  FILE_UNREADABLE: spec('error', 'The file exists but could not be parsed as the format its extension claims.', 'Re-export the asset; validate the source file with its authoring tool. The message carries the parser error.'),
  FORMAT_UNSUPPORTED: spec('error', 'The file extension is not one of glb, gltf, usdz, usda, usdc, usd.', 'Convert to GLB or USDZ first (export_usdz for USDZ).'),
  GLTF_VERSION_UNSUPPORTED: spec('error', 'asset.version is not 2.x.', 'Re-export as glTF 2.0.'),
  EXTENSION_UNSUPPORTED: spec('error', 'An extension listed in extensionsRequired is unknown to this toolset; loaders that lack it will refuse the file.', 'Re-export without the extension, or optimize_glb to rewrite compression with EXT_meshopt_compression.'),
  BUFFER_UNRESOLVED: spec('error', 'A .gltf buffer URI could not be resolved on disk.', 'Place the .bin next to the .gltf or pack into a single GLB.'),
  USDZ_ENTRY_COMPRESSED: spec('error', 'A usdz zip entry uses compression; the USDZ spec requires stored (method 0) entries.', 'Repack with export_usdz (store-only) or `usdzip`.'),
  USDZ_ENTRY_MISALIGNED: spec('error', 'A usdz entry payload does not start on a 64-byte boundary.', 'Repack with export_usdz or `usdzip`; generic zip tools do not align.'),
  USDZ_FILE_TYPE_DISALLOWED: spec('error', 'A usdz entry has a file type the USDZ spec does not allow (only usd/usda/usdc/usdz, png/jpg/jpeg/exr/avif, m4a/mp3/wav).', 'Remove or convert the file; textures must be PNG or JPEG for AR Quick Look.'),
  USDZ_NO_LAYER: spec('error', 'The usdz package contains no USD layer.', 'Pack a .usdc/.usda as the first entry.'),
  USDZ_LAYER_NOT_FIRST: spec('warning', 'The first entry of the usdz is not a USD layer; USD uses the first layer as the package root.', 'Repack with the root layer as the first entry.'),
  USDZ_NESTED_PACKAGE: spec('warning', 'The usdz contains another usdz; AR Quick Look does not open nested packages.', 'Flatten into one package.'),
  USDZ_ARCHIVE_INVALID: spec('error', 'The usdz zip structure is broken (bad local header, truncated, or central directory mismatch).', 'Repack with export_usdz or `usdzip`.'),
  // --- USD layer ------------------------------------------------------------
  MISSING_DEFAULT_PRIM: spec('warning', 'The layer declares no defaultPrim; it cannot be referenced or payloaded, and some viewers pick an arbitrary root.', 'Set defaultPrim to the root prim (export_usdz always writes one).'),
  DEFAULT_PRIM_NOT_FOUND: spec('error', 'defaultPrim names a prim that does not exist at the root of the layer.', 'Point defaultPrim at an existing root prim.'),
  UP_AXIS_Z: spec('warning', 'upAxis is Z; AR Quick Look, glTF and most web viewers assume Y-up and will show the asset lying on its side unless they honor the metadata.', 'Author Y-up geometry, or bake a -90° X rotation on the root and set upAxis = "Y".'),
  MISSING_UP_AXIS: spec('info', 'No upAxis metadata; consumers fall back to Y.', 'Declare upAxis = "Y" explicitly.'),
  METERS_PER_UNIT_NONSTANDARD: spec('warning', 'metersPerUnit is not 1 (e.g. 0.01 = centimetres); viewers that ignore it show the asset at the wrong size.', 'Bake the scale into the geometry and set metersPerUnit = 1.'),
  MISSING_METERS_PER_UNIT: spec('info', 'No metersPerUnit metadata; consumers fall back to 1 (metres).', 'Declare metersPerUnit = 1 explicitly.'),
  UNRESOLVED_COMPOSITION_ARC: spec('info', 'The layer uses references, payloads, sublayers, variants, inherits, specializes or clips. This toolset reads a single layer and does not compose; prims behind the arc are not inspected.', 'Flatten the stage (usdcat --flatten) before inspecting, or inspect the referenced layer directly.'),
  USD_SCHEMA_ERROR: spec('error', 'A prim is structurally invalid for its type (e.g. a Mesh without points or with mismatched face arrays).', 'Fix the property named in `property`; see the message for the expected shape.'),
  MESH_INDEX_OUT_OF_RANGE: spec('error', 'faceVertexIndices (or an index buffer) references a vertex that does not exist.', 'Re-export the mesh; indices must be < the vertex count.'),
  PRIM_TYPE_UNSUPPORTED_ARKIT: spec('warning', 'A prim type AR Quick Look does not render (curves, points, volumes, NURBS, cameras, lights).', 'Convert to Mesh or remove the prim.'),
  SHADER_NOT_PREVIEWSURFACE: spec('warning', 'A material uses a shader other than UsdPreviewSurface / UsdUVTexture / UsdPrimvarReader / UsdTransform2d; AR Quick Look renders it as a default grey surface.', 'Re-author as UsdPreviewSurface (export_usdz does this from glTF PBR).'),
  SUBDIVISION_UNSUPPORTED: spec('info', 'subdivisionScheme is not "none"; renderers that subdivide will smooth the mesh and change its silhouette.', 'Set subdivisionScheme = "none" for polygonal assets.'),
  // --- geometry -------------------------------------------------------------
  MESH_EMPTY: spec('warning', 'A mesh prim has no triangles.', 'Remove the prim or re-export it.'),
  MESH_NON_MANIFOLD: spec('info', 'Edges shared by three or more faces. Harmless for display; breaks 3D printing, booleans and some simplifiers.', 'Repair in a DCC if printing or physics matter; optimize_glb tolerates it.'),
  MESH_DEGENERATE_FACES: spec('info', 'Zero-area or repeated-corner faces.', 'optimize_glb prunes them.'),
  TOPO_OPEN_EDGES: spec('warning', 'Edges with only one face after welding by position: real holes or an open surface (UV seams do not count). The mesh is not a closed solid.', 'Fill the holes or cap the surface; merge by distance first if pieces were meant to touch.', 'topo/open-edges'),
  TOPO_SHELLS: spec('info', 'The mesh is several connected pieces of surface rather than one.', 'Join the parts with a boolean union if they should be one solid; fine when they are separate by design.', 'topo/shells'),
  TOPO_FLOATING_FRAGMENTS: spec('warning', 'Tiny disconnected pieces beside the real parts: debris from booleans, cuts or duplicated faces.', 'Delete loose geometry, or join a fragment that is a real detail to its body.', 'topo/floating-fragments'),
  NORMALS_MISSING: spec('warning', 'No authored normals; viewers compute their own (smooth or flat depending on the viewer), so shading differs between apps.', 'optimize_glb writes smooth normals; export_usdz generates them at export time (reported as NORMALS_GENERATED).'),
  NORMALS_INVERTED: spec('warning', 'Authored vertex normals point against the face winding on many faces — the mesh shades dark or inside-out with back-face culling.', 'Recompute normals or flip the face winding in a DCC; optimize_glb with regenerated normals removes the mismatch.'),
  UV_MISSING: spec('info', 'No texture coordinates; the mesh cannot be textured.', 'Unwrap in a DCC, or run the generator\'s texture stage.'),
  UV_OUT_OF_RANGE: spec('info', 'UVs fall outside 0..1; fine with REPEAT wrapping, wrong with CLAMP or atlases.', 'Check wrap modes on the material; re-bake if an atlas was intended.'),
  MESH_UNINDEXED: spec('info', 'Primitive has no index buffer (~3x vertex data, no GPU vertex cache reuse).', 'optimize_glb welds and indexes.'),
  MESH_UNWELDED: spec('info', 'A large share of vertices are exact duplicates across all attributes.', 'optimize_glb welds them.'),
  SCALE_TOO_SMALL: spec('warning', 'Largest world-space dimension is below the small-scale threshold (default 0.01 m); the asset is coin-sized or was exported in the wrong unit.', 'Bake a uniform scale (x100 for centimetre exports) or set metersPerUnit (USD).', 'scale/too-small'),
  SCALE_TOO_LARGE: spec('warning', 'Largest world-space dimension is above the large-scale threshold (default 20 m); too big for AR placement.', 'Bake a uniform scale down; AR assets are usually 0.1–3 m.', 'scale/too-large'),
  PIVOT_NOT_AT_BASE: spec('info', 'The asset origin is not at the bottom of its bounding box; AR placement puts the origin on the surface, so the asset floats or sinks.', 'Translate the root so min.y (or min.z for Z-up) is 0.', 'origin/not-at-base'),
  ORIGIN_OUTSIDE_BOUNDS: spec('warning', 'The world origin lies outside the geometry\'s bounding box: the object floats away from its pivot, so placement, rotation and scaling happen around empty space.', 'Set the origin to the geometry before export, or bake the node translation.', 'origin/outside-bounds'),
  XFORM_UNAPPLIED: spec('warning', 'A mesh-bearing node carries a non-identity transform, so the mesh\'s own coordinates differ from what is seen (quantized meshes are exempt: their node transform is the encoding).', 'Apply the transform before export (Blender: Ctrl+A › All Transforms) or bake the node matrix into the positions.', 'xform/unapplied'),
  XFORM_MIRRORED: spec('warning', 'A mesh-bearing node has a negative-determinant world transform: its faces wind inside-out and single-sided rendering shows the inside.', 'Apply the scale, then recalculate normals outside.', 'xform/mirrored'),
  XFORM_NON_UNIFORM_SCALE: spec('info', 'A mesh-bearing node has non-uniform scale: normals shear under it and STL/USDZ export bakes it.', 'Apply the scale so the geometry carries the shape.', 'xform/non-uniform-scale'),
  // --- intent (only when the caller declared an expectation) -----------------
  INTENT_UP_AXIS: spec('warning', 'The expected up axis differs from the file\'s. On glTF (Y-up by definition) this is informational: the expectation names the authoring space.', 'If the asset lies on its side, bake a −90° X rotation; USD: set upAxis to match the geometry.', 'intent/up-axis'),
  INTENT_UNITS: spec('error', 'Metres were expected but the USD layer declares another metersPerUnit.', 'Bake the scale and set metersPerUnit = 1.', 'intent/units'),
  INTENT_SHELLS: spec('error', 'The connected shell count (welded space) is not the expected count or range.', 'Union the parts that should be one solid, delete loose fragments, or separate the parts.', 'intent/shells'),
  INTENT_WATERTIGHT: spec('error', 'The asset was expected to be a closed solid (or an open surface) and is not.', 'Fix the topo/open-edges and topo/non-manifold findings, then re-inspect.', 'intent/watertight'),
  INTENT_SIZE: spec('error', 'The measured extent is outside the expected range in metres.', 'Scale the asset, or fix the exporter\'s unit scale when the cause is a unit mix-up.', 'intent/size'),
  INTENT_CATEGORY_SCALE: spec('warning', 'Heuristic: the size is outside the typical range for the declared category (coarse table of priors; carries a confidence).', 'Pass an explicit size range to make the check exact, or scale the asset.', 'intent/category-scale'),
  INTENT_CATEGORY_UNKNOWN: spec('info', 'The declared category has no entry in the size table; plausibility stays unknown.', 'Give an explicit size range.', 'intent/category-unknown'),
  INTENT_ORIGIN: spec('error', 'The origin is not at the expected landmark (base centre / centre / centroid).', 'Translate the geometry by the offset in the finding.', 'intent/origin'),
  // --- diff (two versions of an asset) --------------------------------------
  DIFF_WATERTIGHT_LOST: spec('warning', 'A mesh that was a closed solid before is not any more: open loops or non-manifold edges appeared.', 'Inspect the after file; fill the holes or clean the overlaps, or undo the edit.', 'diff/watertight-lost'),
  DIFF_OPEN_EDGES_INTRODUCED: spec('warning', 'More boundary loops than before on a mesh that was already open.', 'Fill the new holes, or undo the edit.', 'diff/open-edges-introduced'),
  DIFF_NON_MANIFOLD_INTRODUCED: spec('warning', 'More non-manifold edges than before on a mesh that was already not watertight.', 'Merge by distance and delete interior faces, or undo the edit.', 'diff/non-manifold-introduced'),
  DIFF_SHELLS_CHANGED: spec('warning', 'The connected-shell count changed: pieces detached (warning) or joined (info).', 'Union pieces that should be one solid; look for floating fragments.', 'diff/shells-changed'),
  DIFF_ORIGIN_MOVED: spec('warning', 'The geometry moved relative to the origin: the landmark changed or the bounds centre shifted beyond tolerance.', 'Translate back if unintended, or set the origin deliberately.', 'diff/origin-moved'),
  DIFF_TRANSFORM_CHANGED: spec('warning', 'A mesh-bearing node\'s local transform changed (dequantization transforms excluded).', 'Apply the transform if it is intended geometry; otherwise reset it.', 'diff/transform-changed'),
  DIFF_SIZE_CHANGED: spec('info', 'The world bounding box changed on some axis; per-mesh deltas name which part got wider, narrower, taller, shorter, deeper or shallower.', 'Nothing to do if intended.', 'diff/size-changed'),
  DIFF_TRIANGLES_CHANGED: spec('info', 'Triangle count changed by at least 1%.', 'Nothing to do if intended.', 'diff/triangles-changed'),
  DIFF_MESHES_REMOVED: spec('info', 'Mesh primitives present before are gone (deleted, joined, or renumbered on export).', 'Nothing to do if intended.', 'diff/meshes-removed'),
  DIFF_MESHES_ADDED: spec('info', 'New mesh primitives appeared.', 'Nothing to do if intended.', 'diff/meshes-added'),
  DIFF_TOPOLOGY_IMPROVED: spec('info', 'A mesh became watertight or lost open loops / non-manifold edges.', 'Nothing to do.', 'diff/topology-improved'),
  DIFF_VISUAL_CHANGED: spec('info', 'Canonical-view SSIM (front / side / top / iso, cameras fixed to the before framing) dropped below 0.995 on some view.', 'Render both from the worst view to see the change.', 'diff/visual-changed'),
  ZUP_SUSPECTED: spec('info', 'glTF is Y-up by definition, but the bounding box is much taller along Z than Y — the geometry may have been exported Z-up.', 'Check the render; if it lies on its side, bake a -90° X rotation.'),
  // --- animation ------------------------------------------------------------
  SKELETON_UNBOUND: spec('warning', 'A skeleton/skin is not bound to any mesh, so its animation deforms nothing.', 'Bind the mesh (glTF: node.skin; USD: rel skel:skeleton + SkelBindingAPI) or remove the skeleton.'),
  MESH_NOT_DEFORMING: spec('warning', 'A skeleton animates, but its bound mesh has no joint influences (missing JOINTS/WEIGHTS or primvars:skel:jointIndices/jointWeights), so it stays rigid.', 'Re-export with skin weights, or bind the mesh rigidly to a joint.'),
  SKIN_UNBOUND_VERTICES: spec('warning', 'Vertices whose joint weights sum to zero; they stay at the bind pose while the rest of the mesh animates.', 'Re-skin those vertices in a DCC (normalize weights).'),
  SKIN_TOO_MANY_INFLUENCES: spec('info', 'More than 4 influences per vertex; USDZ export and many runtimes keep only the first 4.', 'Limit influences to 4 when exporting.'),
  BLENDSHAPE_UNDRIVEN: spec('warning', 'A blend shape / morph target has no animation driving its weight and a zero default weight, so it never appears.', 'Animate the weight (glTF weights channel / USD blendShapeWeights) or drop the target.'),
  ANIMATION_ZERO_LENGTH: spec('warning', 'A clip has zero duration (one key or identical times).', 'Author at least two keyframes.'),
  ANIMATION_NO_MOTION: spec('info', 'A clip has keyframes but every channel is constant — nothing visibly moves.', 'Check the export; the clip may be a placeholder.'),
  SKELETON_NO_ANIMATION: spec('info', 'A skeleton is bound and skinned but no clip animates its joints; the asset is static.', 'Add a clip, or expect a static pose.'),
  ROOT_MOTION: spec('info', 'The root joint/node translates over the clip (root motion); in-place playback will drift.', 'Strip root translation if the runtime expects in-place animation.'),
  NODE_ANIMATION_DROPPED: spec('warning', 'Node (non-skeletal) animation channels exist that the target format or export cannot carry.', 'Bake into a skeleton, or accept a static pose in USDZ.'),
  CLIPS_DROPPED: spec('warning', 'Only the first animation clip is exported; the others are dropped.', 'Export one GLB per clip, or merge clips before export.'),
  INFLUENCES_TRUNCATED: spec('warning', 'Joint influences beyond 4 per vertex were dropped on export.', 'Limit influences to 4 before export to control which are kept.'),
  // --- materials / textures ------------------------------------------------
  TEXTURE_UNRESOLVED: spec('error', 'A texture file referenced by a material could not be found (missing external file, or a usdz entry that does not exist).', 'Fix the path or pack the image; export_usdz/optimize_glb embed textures.'),
  MATERIAL_UNBOUND: spec('info', 'A material is not bound to any mesh.', 'Remove it (optimize_glb prunes unused materials) or bind it.'),
  MESH_NO_MATERIAL: spec('warning', 'A mesh has no material binding; viewers show a default white/grey (or magenta) surface.', 'Bind a material; export_usdz binds a neutral default and reports DEFAULT_MATERIAL_BOUND.'),
  TEXTURE_OVERSIZED: spec('warning', 'A texture exceeds the size threshold (default 2048 px).', 'optimize_glb resizes to the profile cap; pass a smaller maxTextureSize if needed.'),
  TEXTURE_NPOT: spec('info', 'Texture dimensions are not powers of two; some runtimes skip mipmaps or fail to wrap.', 'Resize to a power of two (optimize_glb keeps aspect; re-bake in a DCC for exact POT).'),
  TEXTURE_FORMAT_UNSUPPORTED: spec('warning', 'Texture encoding the target cannot decode (KTX2/WebP for AR Quick Look; EXR for the web).', 'export_usdz transcodes to PNG/JPEG; optimize_glb with textureFormat=webp for the web.'),
  TEXTURE_UNUSED: spec('info', 'A texture is not referenced by any material.', 'optimize_glb prunes it.'),
  MATERIAL_FEATURE_UNSUPPORTED: spec('warning', 'Material uses a feature the target cannot represent (transmission, clearcoat, sheen, iridescence, MaterialX…).', 'Approximate with base PBR before export.'),
  MATERIAL_ALPHA_BLEND: spec('info', 'Material uses alpha blending, which disables depth-write and causes sorting artifacts.', 'Use MASK (cutout) when the alpha is binary.'),
  MATERIAL_BLEND_WITHOUT_ALPHA: spec('warning', 'Material is set to BLEND but its base color image has no alpha channel — the blending buys artifacts for nothing.', 'Switch alphaMode to OPAQUE.'),
  MATERIALS_DUPLICATE: spec('info', 'Materials with identical render state under different names (one draw call each).', 'optimize_glb deduplicates and joins.'),
  DEFAULT_MATERIAL_BOUND: spec('warning', 'The export bound a neutral default material to primitives that had none (not requested; reported so nothing changes silently).', 'Author a material on the source mesh to control the look.'),
  TEXTURE_TRANSCODED: spec('info', 'Textures were re-encoded to a format the target allows (e.g. WebP → PNG/JPEG for USDZ).', 'Nothing to do; pass jpeg=true for smaller USDZ color maps.'),
  // --- performance ----------------------------------------------------------
  TRIANGLE_BUDGET_EXCEEDED: spec('error', 'Total triangles exceed the profile limit.', 'optimize_glb with targetTriangles at or below the limit.'),
  VERTEX_BUDGET_EXCEEDED: spec('error', 'Total vertices exceed the profile limit.', 'optimize_glb (weld + simplify).'),
  DRAW_CALL_BUDGET_EXCEEDED: spec('error', 'Estimated draw calls (one per primitive / material binding) exceed the profile limit.', 'optimize_glb joins primitives that share a material; palette or atlas materials first.'),
  FILE_SIZE_BUDGET_EXCEEDED: spec('error', 'File size exceeds the profile limit.', 'optimize_glb (meshopt + WebP) typically cuts 80–95%.'),
  GPU_MEMORY_BUDGET_EXCEEDED: spec('error', 'Estimated GPU memory (decoded textures + geometry) exceeds the profile limit.', 'Reduce texture size or use KTX2 (textureFormat=ktx2).'),
  TEXTURE_SIZE_BUDGET_EXCEEDED: spec('error', 'A texture is larger than the profile\'s maximum dimension.', 'optimize_glb resizes textures to the profile cap.'),
  TEXTURE_BYTES_BUDGET_EXCEEDED: spec('error', 'Total encoded texture payload exceeds the profile limit.', 'optimize_glb re-encodes textures (WebP) and resizes.'),
  MATERIAL_BUDGET_EXCEEDED: spec('error', 'Material count exceeds the profile limit.', 'Merge materials (palette/atlas); optimize_glb palettes solid colors.'),
  PRIM_COUNT_BUDGET_EXCEEDED: spec('error', 'Scene-graph prim/node count exceeds the profile limit.', 'Flatten the hierarchy (optimize_glb flattens and joins).'),
  SCENE_DEPTH_BUDGET_EXCEEDED: spec('error', 'Scene-graph depth exceeds the profile limit.', 'Flatten the hierarchy.'),
  INSTANCING_CANDIDATE: spec('info', 'Several meshes carry identical geometry but are separate copies; instancing would share one buffer.', 'Export with instancing (EXT_mesh_gpu_instancing / USD instanceable) or accept the duplication.'),
  FIDELITY_BELOW_FLOOR: spec('error', 'Measured visual fidelity (SSIM of fixed-camera renders before vs after) is below the profile floor — the change is visible.', 'Raise targetTriangles or loosen the profile; inspect the comparison sheet for where it lost detail.'),
  FIDELITY_MEASURED: spec('info', 'Measured visual fidelity passed the profile floor (number in data).', 'Nothing to do.'),
  LOD_TARGET_MISSED: spec('warning', 'A LOD could not reach its triangle target (topology stalled the simplifier).', 'Accept the count, or lower the target further; check MESH_NON_MANIFOLD.'),
  // --- mutations reported (never silently fix) -------------------------------
  NORMALS_GENERATED: spec('warning', 'Smooth vertex normals were generated for primitives that had none (the caller did not ask for it explicitly).', 'Author normals upstream if a different shading was intended.'),
  PRIMITIVES_JOINED: spec('warning', 'Primitives sharing a material were merged into one draw call; their original prim paths no longer exist.', 'Use the new paths from `diff`; pass compress/join options if you need them separate.'),
  MATERIALS_PALETTED: spec('warning', 'Solid-color materials were merged into a palette texture.', 'Nothing to do unless the materials must stay separate.'),
  HIERARCHY_FLATTENED: spec('warning', 'The node hierarchy was flattened (transforms baked); node paths changed.', 'Use the new paths from `diff`.'),
  MESH_WELDED: spec('info', 'Duplicate vertices were welded.', 'Nothing to do.'),
  MESH_SIMPLIFIED: spec('info', 'Geometry was simplified to the triangle target (requested).', 'Check `fidelity`; raise targetTriangles if detail was lost.'),
  TEXTURES_REENCODED: spec('info', 'Textures were resized/re-encoded (requested).', 'Nothing to do.'),
  DEGENERATE_PRUNED: spec('info', 'Degenerate triangles were pruned.', 'Nothing to do.'),
  UV_FLIPPED: spec('info', 'Texture V coordinates were flipped for the target convention (glTF top-down → USD bottom-up).', 'Nothing to do.'),
  AXIS_CONVERTED: spec('info', 'The asset was rotated to the target up-axis (e.g. Z-up for STL).', 'Nothing to do.'),
  SCALE_CONVERTED: spec('info', 'The asset was rescaled to the target unit (e.g. millimetres for STL).', 'Nothing to do.'),
  MORPH_TARGETS_DROPPED: spec('warning', 'Morph targets were not carried to the output format.', 'Bake the desired shape, or use a format that carries them.'),
  ANIMATED_ASSET: spec('info', 'The asset has skins or animation clips; optimization is bone-aware and USDZ export carries the skeleton and first clip.', 'Budget triangles with deformation cost in mind.'),
  GENERATOR_FINGERPRINT: spec('info', 'The producing generator was recognized from the file\'s structure; suggestions are tailored to its known weak spots.', 'Nothing to do.'),
  // --- rendering ------------------------------------------------------------
  NO_GEOMETRY_TO_RENDER: spec('warning', 'The scene has no renderable triangles.', 'Check MESH_EMPTY / composition arcs.'),
  FRAME_OUT_OF_RANGE: spec('warning', 'A requested frame lies outside the clip; it was clamped to the nearest end.', 'Use frames within time_code_range from inspect_animation.'),
  CLIP_FORMAT_UNSUPPORTED: spec('info', 'include_clip could not produce the requested clip format with this stack (no mp4 encoder); a GIF was written instead when possible.', 'Use the GIF, or assemble the frames with ffmpeg.'),
  DRY_RUN: spec('info', 'dry_run=true: nothing was written; `diff` shows what would change.', 'Re-run with dry_run=false to apply.'),
  ROUTED_TO_GENERATION: spec('info', 'The input looks photographic; deterministic extrusion was skipped in favor of a generation route.', 'Call generate_image_to_3d as listed in nextActions.'),
  TOOL_ERROR: spec('error', 'The tool failed before producing a result; the message carries the underlying error.', 'Fix the input (path, arguments) and retry.'),
} as const satisfies Record<string, CodeSpec>;

export type DiagnosticCode = keyof typeof ERROR_CODES;

/** Build a diagnostic with the registry's default severity (override only when a rule downgrades). */
export function diag(
  code: DiagnosticCode,
  prim_path: string,
  message: string,
  extra: { property?: string; suggested_fix?: string; severity?: DiagnosticSeverity; data?: Record<string, unknown> } = {},
): Diagnostic {
  const s = ERROR_CODES[code];
  return {
    code,
    severity: extra.severity ?? s.severity,
    prim_path,
    ...(extra.property ? { property: extra.property } : {}),
    message,
    suggested_fix: extra.suggested_fix ?? s.fix,
    ...(extra.data ? { data: extra.data } : {}),
  };
}

const RANK: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Errors first, then warnings, then info; stable within a severity. */
export function sortDiagnostics(list: Diagnostic[]): Diagnostic[] {
  return list.map((d, i) => [d, i] as const).sort((a, b) => RANK[a[0].severity] - RANK[b[0].severity] || a[1] - b[1]).map(([d]) => d);
}

export function countBySeverity(list: Diagnostic[]): { errors: number; warnings: number; info: number } {
  return {
    errors: list.filter((d) => d.severity === 'error').length,
    warnings: list.filter((d) => d.severity === 'warning').length,
    info: list.filter((d) => d.severity === 'info').length,
  };
}

/** Legacy analyze() rule ids → codes, so the existing report card speaks the same language. */
export const RULE_TO_CODE: Record<string, DiagnosticCode> = {
  'perf/triangle-budget': 'TRIANGLE_BUDGET_EXCEEDED',
  'perf/draw-calls': 'DRAW_CALL_BUDGET_EXCEEDED',
  'perf/file-size': 'FILE_SIZE_BUDGET_EXCEEDED',
  'tex/oversized': 'TEXTURE_SIZE_BUDGET_EXCEEDED',
  'tex/total-weight': 'TEXTURE_BYTES_BUDGET_EXCEEDED',
  'tex/vram-estimate': 'GPU_MEMORY_BUDGET_EXCEEDED',
  'geo/missing-normals': 'NORMALS_MISSING',
  'geo/missing-uvs': 'UV_MISSING',
  'geo/unindexed': 'MESH_UNINDEXED',
  'mat/no-material': 'MESH_NO_MATERIAL',
  'mat/duplicate-materials': 'MATERIALS_DUPLICATE',
  'mat/blend-without-alpha': 'MATERIAL_BLEND_WITHOUT_ALPHA',
  'mat/blend-alpha': 'MATERIAL_ALPHA_BLEND',
  'topo/unwelded': 'MESH_UNWELDED',
  'topo/non-manifold': 'MESH_NON_MANIFOLD',
  'topo/degenerate': 'MESH_DEGENERATE_FACES',
  'gen/profile': 'GENERATOR_FINGERPRINT',
  'scene/animated-asset': 'ANIMATED_ASSET',
  'scene/scale-sanity': 'SCALE_TOO_LARGE',
  'fidelity/perceptual': 'FIDELITY_BELOW_FLOOR',
};

/** Markdown for docs/error-codes.md, generated from the registry. */
export function renderErrorCodesMarkdown(): string {
  const lines = [
    '# Error codes',
    '',
    'Every diagnostic the GLBForge MCP tools emit carries one of these codes. Agents should branch on the code, not on message text.',
    'Severity: **error** = fatal / will not load (or the tool could not run); **warning** = loads but is likely wrong, or was changed without being asked; **info** = advisory.',
    '',
    'Codes are aliases of the slash-namespaced **rule ids** (`topo/open-edges`, `perf/triangle-budget`, …), which are the public, versioned API: a rule is versioned by its pack (`core-geometry@1`) the way a budget is versioned by its profile (`mobile-hero@1`). The rule column is blank for codes that report a tool outcome rather than a rule.',
    '',
    'Generated from `packages/core/src/inspect/diagnostics.ts` (`ERROR_CODES`); a test keeps this file in sync.',
    '',
    '| Code | Rule id | Severity | Meaning | Typical fix |',
    '|---|---|---|---|---|',
  ];
  const ruleOf = new Map<string, string>(Object.entries(RULE_TO_CODE).map(([rule, code]) => [code, rule]));
  for (const [code, s] of Object.entries(ERROR_CODES)) {
    const rule = (s as CodeSpec).rule ?? ruleOf.get(code) ?? '';
    lines.push(`| \`${code}\` | ${rule ? `\`${rule}\`` : ''} | ${s.severity} | ${s.meaning.replace(/\|/g, '\\|')} | ${s.fix.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  return lines.join('\n');
}
