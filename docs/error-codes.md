# Error codes

Every diagnostic the GLBForge MCP tools emit carries one of these codes. Agents should branch on the code, not on message text.
Severity: **error** = fatal / will not load (or the tool could not run); **warning** = loads but is likely wrong, or was changed without being asked; **info** = advisory.

Codes are aliases of the slash-namespaced **rule ids** (`topo/open-edges`, `perf/triangle-budget`, …), which are the public, versioned API: a rule is versioned by its pack (`core-geometry@1`) the way a budget is versioned by its profile (`mobile-hero@1`). The rule column is blank for codes that report a tool outcome rather than a rule.

Generated from `packages/core/src/inspect/diagnostics.ts` (`ERROR_CODES`); a test keeps this file in sync.

| Code | Rule id | Severity | Meaning | Typical fix |
|---|---|---|---|---|
| `FILE_NOT_FOUND` |  | error | The path does not exist or is not readable. | Check the absolute path; use audit_directory to list assets. |
| `FILE_UNREADABLE` |  | error | The file exists but could not be parsed as the format its extension claims. | Re-export the asset; validate the source file with its authoring tool. The message carries the parser error. |
| `FORMAT_UNSUPPORTED` |  | error | The file extension is not one of glb, gltf, usdz, usda, usdc, usd. | Convert to GLB or USDZ first (export_usdz for USDZ). |
| `GLTF_VERSION_UNSUPPORTED` |  | error | asset.version is not 2.x. | Re-export as glTF 2.0. |
| `EXTENSION_UNSUPPORTED` |  | error | An extension listed in extensionsRequired is unknown to this toolset; loaders that lack it will refuse the file. | Re-export without the extension, or optimize_glb to rewrite compression with EXT_meshopt_compression. |
| `BUFFER_UNRESOLVED` |  | error | A .gltf buffer URI could not be resolved on disk. | Place the .bin next to the .gltf or pack into a single GLB. |
| `USDZ_ENTRY_COMPRESSED` |  | error | A usdz zip entry uses compression; the USDZ spec requires stored (method 0) entries. | Repack with export_usdz (store-only) or `usdzip`. |
| `USDZ_ENTRY_MISALIGNED` |  | error | A usdz entry payload does not start on a 64-byte boundary. | Repack with export_usdz or `usdzip`; generic zip tools do not align. |
| `USDZ_FILE_TYPE_DISALLOWED` |  | error | A usdz entry has a file type the USDZ spec does not allow (only usd/usda/usdc/usdz, png/jpg/jpeg/exr/avif, m4a/mp3/wav). | Remove or convert the file; textures must be PNG or JPEG for AR Quick Look. |
| `USDZ_NO_LAYER` |  | error | The usdz package contains no USD layer. | Pack a .usdc/.usda as the first entry. |
| `USDZ_LAYER_NOT_FIRST` |  | warning | The first entry of the usdz is not a USD layer; USD uses the first layer as the package root. | Repack with the root layer as the first entry. |
| `USDZ_NESTED_PACKAGE` |  | warning | The usdz contains another usdz; AR Quick Look does not open nested packages. | Flatten into one package. |
| `USDZ_ARCHIVE_INVALID` |  | error | The usdz zip structure is broken (bad local header, truncated, or central directory mismatch). | Repack with export_usdz or `usdzip`. |
| `MISSING_DEFAULT_PRIM` |  | warning | The layer declares no defaultPrim; it cannot be referenced or payloaded, and some viewers pick an arbitrary root. | Set defaultPrim to the root prim (export_usdz always writes one). |
| `DEFAULT_PRIM_NOT_FOUND` |  | error | defaultPrim names a prim that does not exist at the root of the layer. | Point defaultPrim at an existing root prim. |
| `UP_AXIS_Z` |  | warning | upAxis is Z; AR Quick Look, glTF and most web viewers assume Y-up and will show the asset lying on its side unless they honor the metadata. | Author Y-up geometry, or bake a -90° X rotation on the root and set upAxis = "Y". |
| `MISSING_UP_AXIS` |  | info | No upAxis metadata; consumers fall back to Y. | Declare upAxis = "Y" explicitly. |
| `METERS_PER_UNIT_NONSTANDARD` |  | warning | metersPerUnit is not 1 (e.g. 0.01 = centimetres); viewers that ignore it show the asset at the wrong size. | Bake the scale into the geometry and set metersPerUnit = 1. |
| `MISSING_METERS_PER_UNIT` |  | info | No metersPerUnit metadata; consumers fall back to 1 (metres). | Declare metersPerUnit = 1 explicitly. |
| `UNRESOLVED_COMPOSITION_ARC` |  | info | The layer uses references, payloads, sublayers, variants, inherits, specializes or clips. This toolset reads a single layer and does not compose; prims behind the arc are not inspected. | Flatten the stage (usdcat --flatten) before inspecting, or inspect the referenced layer directly. |
| `USD_SCHEMA_ERROR` |  | error | A prim is structurally invalid for its type (e.g. a Mesh without points or with mismatched face arrays). | Fix the property named in `property`; see the message for the expected shape. |
| `MESH_INDEX_OUT_OF_RANGE` |  | error | faceVertexIndices (or an index buffer) references a vertex that does not exist. | Re-export the mesh; indices must be < the vertex count. |
| `PRIM_TYPE_UNSUPPORTED_ARKIT` |  | warning | A prim type AR Quick Look does not render (curves, points, volumes, NURBS, cameras, lights). | Convert to Mesh or remove the prim. |
| `SHADER_NOT_PREVIEWSURFACE` |  | warning | A material uses a shader other than UsdPreviewSurface / UsdUVTexture / UsdPrimvarReader / UsdTransform2d; AR Quick Look renders it as a default grey surface. | Re-author as UsdPreviewSurface (export_usdz does this from glTF PBR). |
| `SUBDIVISION_UNSUPPORTED` |  | info | subdivisionScheme is not "none"; renderers that subdivide will smooth the mesh and change its silhouette. | Set subdivisionScheme = "none" for polygonal assets. |
| `MESH_EMPTY` |  | warning | A mesh prim has no triangles. | Remove the prim or re-export it. |
| `MESH_NON_MANIFOLD` | `topo/non-manifold` | info | Edges shared by three or more faces. Harmless for display; breaks 3D printing, booleans and some simplifiers. | Repair in a DCC if printing or physics matter; optimize_glb tolerates it. |
| `MESH_DEGENERATE_FACES` | `topo/degenerate` | info | Zero-area or repeated-corner faces. | optimize_glb prunes them. |
| `TOPO_OPEN_EDGES` | `topo/open-edges` | warning | Edges with only one face after welding by position: real holes or an open surface (UV seams do not count). The mesh is not a closed solid. | Fill the holes or cap the surface; merge by distance first if pieces were meant to touch. |
| `TOPO_SHELLS` | `topo/shells` | info | The mesh is several connected pieces of surface rather than one. | Join the parts with a boolean union if they should be one solid; fine when they are separate by design. |
| `TOPO_FLOATING_FRAGMENTS` | `topo/floating-fragments` | warning | Tiny disconnected pieces beside the real parts: debris from booleans, cuts or duplicated faces. | Delete loose geometry, or join a fragment that is a real detail to its body. |
| `NORMALS_MISSING` | `geo/missing-normals` | warning | No authored normals; viewers compute their own (smooth or flat depending on the viewer), so shading differs between apps. | optimize_glb writes smooth normals; export_usdz generates them at export time (reported as NORMALS_GENERATED). |
| `NORMALS_INVERTED` |  | warning | Authored vertex normals point against the face winding on many faces — the mesh shades dark or inside-out with back-face culling. | Recompute normals or flip the face winding in a DCC; optimize_glb with regenerated normals removes the mismatch. |
| `UV_MISSING` | `geo/missing-uvs` | info | No texture coordinates; the mesh cannot be textured. | Unwrap in a DCC, or run the generator's texture stage. |
| `UV_OUT_OF_RANGE` |  | info | UVs fall outside 0..1; fine with REPEAT wrapping, wrong with CLAMP or atlases. | Check wrap modes on the material; re-bake if an atlas was intended. |
| `MESH_UNINDEXED` | `geo/unindexed` | info | Primitive has no index buffer (~3x vertex data, no GPU vertex cache reuse). | optimize_glb welds and indexes. |
| `MESH_UNWELDED` | `topo/unwelded` | info | A large share of vertices are exact duplicates across all attributes. | optimize_glb welds them. |
| `SCALE_TOO_SMALL` | `scale/too-small` | warning | Largest world-space dimension is below the small-scale threshold (default 0.01 m); the asset is coin-sized or was exported in the wrong unit. | Bake a uniform scale (x100 for centimetre exports) or set metersPerUnit (USD). |
| `SCALE_TOO_LARGE` | `scale/too-large` | warning | Largest world-space dimension is above the large-scale threshold (default 20 m); too big for AR placement. | Bake a uniform scale down; AR assets are usually 0.1–3 m. |
| `PIVOT_NOT_AT_BASE` | `origin/not-at-base` | info | The asset origin is not at the bottom of its bounding box; AR placement puts the origin on the surface, so the asset floats or sinks. | Translate the root so min.y (or min.z for Z-up) is 0. |
| `ORIGIN_OUTSIDE_BOUNDS` | `origin/outside-bounds` | warning | The world origin lies outside the geometry's bounding box: the object floats away from its pivot, so placement, rotation and scaling happen around empty space. | Set the origin to the geometry before export, or bake the node translation. |
| `XFORM_UNAPPLIED` | `xform/unapplied` | warning | A mesh-bearing node carries a non-identity transform, so the mesh's own coordinates differ from what is seen (quantized meshes are exempt: their node transform is the encoding). | Apply the transform before export (Blender: Ctrl+A › All Transforms) or bake the node matrix into the positions. |
| `XFORM_MIRRORED` | `xform/mirrored` | warning | A mesh-bearing node has a negative-determinant world transform: its faces wind inside-out and single-sided rendering shows the inside. | Apply the scale, then recalculate normals outside. |
| `XFORM_NON_UNIFORM_SCALE` | `xform/non-uniform-scale` | info | A mesh-bearing node has non-uniform scale: normals shear under it and STL/USDZ export bakes it. | Apply the scale so the geometry carries the shape. |
| `ZUP_SUSPECTED` |  | info | glTF is Y-up by definition, but the bounding box is much taller along Z than Y — the geometry may have been exported Z-up. | Check the render; if it lies on its side, bake a -90° X rotation. |
| `SKELETON_UNBOUND` |  | warning | A skeleton/skin is not bound to any mesh, so its animation deforms nothing. | Bind the mesh (glTF: node.skin; USD: rel skel:skeleton + SkelBindingAPI) or remove the skeleton. |
| `MESH_NOT_DEFORMING` |  | warning | A skeleton animates, but its bound mesh has no joint influences (missing JOINTS/WEIGHTS or primvars:skel:jointIndices/jointWeights), so it stays rigid. | Re-export with skin weights, or bind the mesh rigidly to a joint. |
| `SKIN_UNBOUND_VERTICES` |  | warning | Vertices whose joint weights sum to zero; they stay at the bind pose while the rest of the mesh animates. | Re-skin those vertices in a DCC (normalize weights). |
| `SKIN_TOO_MANY_INFLUENCES` |  | info | More than 4 influences per vertex; USDZ export and many runtimes keep only the first 4. | Limit influences to 4 when exporting. |
| `BLENDSHAPE_UNDRIVEN` |  | warning | A blend shape / morph target has no animation driving its weight and a zero default weight, so it never appears. | Animate the weight (glTF weights channel / USD blendShapeWeights) or drop the target. |
| `ANIMATION_ZERO_LENGTH` |  | warning | A clip has zero duration (one key or identical times). | Author at least two keyframes. |
| `ANIMATION_NO_MOTION` |  | info | A clip has keyframes but every channel is constant — nothing visibly moves. | Check the export; the clip may be a placeholder. |
| `SKELETON_NO_ANIMATION` |  | info | A skeleton is bound and skinned but no clip animates its joints; the asset is static. | Add a clip, or expect a static pose. |
| `ROOT_MOTION` |  | info | The root joint/node translates over the clip (root motion); in-place playback will drift. | Strip root translation if the runtime expects in-place animation. |
| `NODE_ANIMATION_DROPPED` |  | warning | Node (non-skeletal) animation channels exist that the target format or export cannot carry. | Bake into a skeleton, or accept a static pose in USDZ. |
| `CLIPS_DROPPED` |  | warning | Only the first animation clip is exported; the others are dropped. | Export one GLB per clip, or merge clips before export. |
| `INFLUENCES_TRUNCATED` |  | warning | Joint influences beyond 4 per vertex were dropped on export. | Limit influences to 4 before export to control which are kept. |
| `TEXTURE_UNRESOLVED` |  | error | A texture file referenced by a material could not be found (missing external file, or a usdz entry that does not exist). | Fix the path or pack the image; export_usdz/optimize_glb embed textures. |
| `MATERIAL_UNBOUND` |  | info | A material is not bound to any mesh. | Remove it (optimize_glb prunes unused materials) or bind it. |
| `MESH_NO_MATERIAL` | `mat/no-material` | warning | A mesh has no material binding; viewers show a default white/grey (or magenta) surface. | Bind a material; export_usdz binds a neutral default and reports DEFAULT_MATERIAL_BOUND. |
| `TEXTURE_OVERSIZED` |  | warning | A texture exceeds the size threshold (default 2048 px). | optimize_glb resizes to the profile cap; pass a smaller maxTextureSize if needed. |
| `TEXTURE_NPOT` |  | info | Texture dimensions are not powers of two; some runtimes skip mipmaps or fail to wrap. | Resize to a power of two (optimize_glb keeps aspect; re-bake in a DCC for exact POT). |
| `TEXTURE_FORMAT_UNSUPPORTED` |  | warning | Texture encoding the target cannot decode (KTX2/WebP for AR Quick Look; EXR for the web). | export_usdz transcodes to PNG/JPEG; optimize_glb with textureFormat=webp for the web. |
| `TEXTURE_UNUSED` |  | info | A texture is not referenced by any material. | optimize_glb prunes it. |
| `MATERIAL_FEATURE_UNSUPPORTED` |  | warning | Material uses a feature the target cannot represent (transmission, clearcoat, sheen, iridescence, MaterialX…). | Approximate with base PBR before export. |
| `MATERIAL_ALPHA_BLEND` | `mat/blend-alpha` | info | Material uses alpha blending, which disables depth-write and causes sorting artifacts. | Use MASK (cutout) when the alpha is binary. |
| `MATERIAL_BLEND_WITHOUT_ALPHA` | `mat/blend-without-alpha` | warning | Material is set to BLEND but its base color image has no alpha channel — the blending buys artifacts for nothing. | Switch alphaMode to OPAQUE. |
| `MATERIALS_DUPLICATE` | `mat/duplicate-materials` | info | Materials with identical render state under different names (one draw call each). | optimize_glb deduplicates and joins. |
| `DEFAULT_MATERIAL_BOUND` |  | warning | The export bound a neutral default material to primitives that had none (not requested; reported so nothing changes silently). | Author a material on the source mesh to control the look. |
| `TEXTURE_TRANSCODED` |  | info | Textures were re-encoded to a format the target allows (e.g. WebP → PNG/JPEG for USDZ). | Nothing to do; pass jpeg=true for smaller USDZ color maps. |
| `TRIANGLE_BUDGET_EXCEEDED` | `perf/triangle-budget` | error | Total triangles exceed the profile limit. | optimize_glb with targetTriangles at or below the limit. |
| `VERTEX_BUDGET_EXCEEDED` |  | error | Total vertices exceed the profile limit. | optimize_glb (weld + simplify). |
| `DRAW_CALL_BUDGET_EXCEEDED` | `perf/draw-calls` | error | Estimated draw calls (one per primitive / material binding) exceed the profile limit. | optimize_glb joins primitives that share a material; palette or atlas materials first. |
| `FILE_SIZE_BUDGET_EXCEEDED` | `perf/file-size` | error | File size exceeds the profile limit. | optimize_glb (meshopt + WebP) typically cuts 80–95%. |
| `GPU_MEMORY_BUDGET_EXCEEDED` | `tex/vram-estimate` | error | Estimated GPU memory (decoded textures + geometry) exceeds the profile limit. | Reduce texture size or use KTX2 (textureFormat=ktx2). |
| `TEXTURE_SIZE_BUDGET_EXCEEDED` | `tex/oversized` | error | A texture is larger than the profile's maximum dimension. | optimize_glb resizes textures to the profile cap. |
| `TEXTURE_BYTES_BUDGET_EXCEEDED` | `tex/total-weight` | error | Total encoded texture payload exceeds the profile limit. | optimize_glb re-encodes textures (WebP) and resizes. |
| `MATERIAL_BUDGET_EXCEEDED` |  | error | Material count exceeds the profile limit. | Merge materials (palette/atlas); optimize_glb palettes solid colors. |
| `PRIM_COUNT_BUDGET_EXCEEDED` |  | error | Scene-graph prim/node count exceeds the profile limit. | Flatten the hierarchy (optimize_glb flattens and joins). |
| `SCENE_DEPTH_BUDGET_EXCEEDED` |  | error | Scene-graph depth exceeds the profile limit. | Flatten the hierarchy. |
| `INSTANCING_CANDIDATE` |  | info | Several meshes carry identical geometry but are separate copies; instancing would share one buffer. | Export with instancing (EXT_mesh_gpu_instancing / USD instanceable) or accept the duplication. |
| `FIDELITY_BELOW_FLOOR` | `fidelity/perceptual` | error | Measured visual fidelity (SSIM of fixed-camera renders before vs after) is below the profile floor — the change is visible. | Raise targetTriangles or loosen the profile; inspect the comparison sheet for where it lost detail. |
| `FIDELITY_MEASURED` |  | info | Measured visual fidelity passed the profile floor (number in data). | Nothing to do. |
| `LOD_TARGET_MISSED` |  | warning | A LOD could not reach its triangle target (topology stalled the simplifier). | Accept the count, or lower the target further; check MESH_NON_MANIFOLD. |
| `NORMALS_GENERATED` |  | warning | Smooth vertex normals were generated for primitives that had none (the caller did not ask for it explicitly). | Author normals upstream if a different shading was intended. |
| `PRIMITIVES_JOINED` |  | warning | Primitives sharing a material were merged into one draw call; their original prim paths no longer exist. | Use the new paths from `diff`; pass compress/join options if you need them separate. |
| `MATERIALS_PALETTED` |  | warning | Solid-color materials were merged into a palette texture. | Nothing to do unless the materials must stay separate. |
| `HIERARCHY_FLATTENED` |  | warning | The node hierarchy was flattened (transforms baked); node paths changed. | Use the new paths from `diff`. |
| `MESH_WELDED` |  | info | Duplicate vertices were welded. | Nothing to do. |
| `MESH_SIMPLIFIED` |  | info | Geometry was simplified to the triangle target (requested). | Check `fidelity`; raise targetTriangles if detail was lost. |
| `TEXTURES_REENCODED` |  | info | Textures were resized/re-encoded (requested). | Nothing to do. |
| `DEGENERATE_PRUNED` |  | info | Degenerate triangles were pruned. | Nothing to do. |
| `UV_FLIPPED` |  | info | Texture V coordinates were flipped for the target convention (glTF top-down → USD bottom-up). | Nothing to do. |
| `AXIS_CONVERTED` |  | info | The asset was rotated to the target up-axis (e.g. Z-up for STL). | Nothing to do. |
| `SCALE_CONVERTED` |  | info | The asset was rescaled to the target unit (e.g. millimetres for STL). | Nothing to do. |
| `MORPH_TARGETS_DROPPED` |  | warning | Morph targets were not carried to the output format. | Bake the desired shape, or use a format that carries them. |
| `ANIMATED_ASSET` | `scene/animated-asset` | info | The asset has skins or animation clips; optimization is bone-aware and USDZ export carries the skeleton and first clip. | Budget triangles with deformation cost in mind. |
| `GENERATOR_FINGERPRINT` | `gen/profile` | info | The producing generator was recognized from the file's structure; suggestions are tailored to its known weak spots. | Nothing to do. |
| `NO_GEOMETRY_TO_RENDER` |  | warning | The scene has no renderable triangles. | Check MESH_EMPTY / composition arcs. |
| `FRAME_OUT_OF_RANGE` |  | warning | A requested frame lies outside the clip; it was clamped to the nearest end. | Use frames within time_code_range from inspect_animation. |
| `CLIP_FORMAT_UNSUPPORTED` |  | info | include_clip could not produce the requested clip format with this stack (no mp4 encoder); a GIF was written instead when possible. | Use the GIF, or assemble the frames with ffmpeg. |
| `DRY_RUN` |  | info | dry_run=true: nothing was written; `diff` shows what would change. | Re-run with dry_run=false to apply. |
| `ROUTED_TO_GENERATION` |  | info | The input looks photographic; deterministic extrusion was skipped in favor of a generation route. | Call generate_image_to_3d as listed in nextActions. |
| `TOOL_ERROR` |  | error | The tool failed before producing a result; the message carries the underlying error. | Fix the input (path, arguments) and retry. |
