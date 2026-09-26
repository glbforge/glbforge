# Pass — 2026-09-26 — 8b223a6
**Role:** rival

`pnpm ledger` names rival as least-recently-used (never run against main's
merged history). Checked `gh pr list` first: six rival PRs (#28, #38, #39,
#40, #42, #44) are already open against gltf-transform/gltfpack on size,
Khronos gltf-validator on conformance, ssim.js on the SSIM oracle, a Manifold
geometry oracle on watertightness, and gltfpack on LOD fidelity. None of them
touch the forge/extrude pipeline, so that's where this pass looked instead:
one real asset (a vector circle) through `extrude_image` and through the DIY
path an agent would reach for directly in three.js — `SVGLoader`/`Shape` +
`ExtrudeGeometry` + `GLTFExporter`, all three already a dependency of
`@glbforge/studio`. Ground truth first: `pnpm install && pnpm -r build`,
`pnpm -r test` (21+2+3+2 files, all green), `pnpm probe -- --no-live` clean,
no regressions vs baseline.

## The table

Same depth (0.08 m), same world scale, a plain circle (the simplest curved
silhouette) so triangle count and geometric deviation are unambiguous to
measure. GLBForge traces a rasterized PNG at increasing canvas size; three.js
builds the circle analytically (`Shape.absarc`) and extrudes at increasing
`curveSegments`. Deviation is the max distance, in mm, from every front-cap
vertex to the true circle radius (391 mm, in this 1 m-wide, 512 px-canvas
scene).

| source | triangles | GLB bytes | build ms | max radius deviation |
|---|---|---|---|---|
| GLBForge, 64px raster | 252 | 16,340 | 11.2 | **15.90 mm** (4.1% of radius) |
| GLBForge, 128px raster | 252 | 16,348 | 9.0 | **10.76 mm** (2.8%) |
| GLBForge, 256px raster | 508 | 31,712 | 14.3 | **3.74 mm** (0.96%) |
| GLBForge, 512px raster | 588 | 36,516 | 31.5 | **2.66 mm** (0.68%) |
| GLBForge, 1024px raster | 1,020 | 62,444 | 80.1 | **1.00 mm** (0.25%) |
| three.js, 32 segments | 256 | 25,692 | 5.3 | 0.000011 mm |
| three.js, 64 segments | 512 | 50,272 | 3.8 | 0.000018 mm |

**GLBForge loses, badly, at matched triangle count.** At ~256 triangles
GLBForge's traced circle is off by 3.74 mm; three's analytic circle at the
same triangle count is off by 0.00001 mm — five orders of magnitude tighter.
Doubling the triangle budget (~512) barely moves GLBForge's number (2.66 mm)
because the error is bounded by *source pixels*, not by triangle count: no
amount of Douglas-Peucker tolerance or bevel segments recovers precision the
raster trace never had.

**Where GLBForge wins, and why the comparison is narrower than the table
suggests:** three.js has no answer at all for GLBForge's actual target case —
a raster PNG/JPEG/WebP logo with no vector source. Reaching this table's
three.js numbers requires already having clean vector art and hand-writing
the shape, extrude, and export calls yourself (four imports, a `FileReader`
polyfill to get binary GLB out of `GLTFExporter` under Node — it assumes a
browser's `Blob`/`FileReader`, which Node doesn't ship). GLBForge's one call
also gives bevel, pillow, emboss, layered-color extrusion, and a projected
texture — none of which `ExtrudeGeometry` does out of the box, and it wins
easily on wall-clock and file size where a PNG source needs tracing at all
(the DIY path can't touch a PNG). The honest comparison is: *for vector
source, three.js has near-zero geometric error and GLBForge doesn't; for
raster source (the overwhelmingly common logo/PNG case GLBForge is actually
built for), three.js isn't a comparison, it's a different, harder job.*

### L12 · `fixed` · `extrude_image`'s curve fidelity is resolution-bounded and nothing said so

While building the table, checked why `extrudeImage` (`core/src/extrude/index.ts`)
already handles SVG input by rasterizing it "generously... so the trace grid
is saturated" (density 300, upscaled to `TRACE_MAX * 2` = 2048 px) — a
deliberate mitigation for exactly the error this table measures. A plain
raster PNG/JPEG/WebP gets none of that: it's resized with
`withoutEnlargement: true`, so a 128×256 px source logo traces at its own
native resolution and gets exactly the faceting in the table above (measured
2.8%–0.96% of radius) — silently, since nothing in the MCP tool description,
the CLI `--help` text, README, or `site/llms.txt` said curve fidelity depends
on source resolution at all, or that a favicon-sized PNG would forge a
visibly faceted circle. An agent handed "forge this round logo" and a small
PNG from a design tool would get a faceted result with no warning and no
lever to reach for.

Fixed with a one-line addition to `extrude_image`'s MCP description
(`packages/mcp/src/server.ts`) and the CLI's `extrude` command description
(`packages/cli/src/index.ts`), stating the SVG-vs-raster asymmetry and a
measured rule of thumb (512px+ for curves). Regenerated `schemas/` via
`pnpm -r build`. New test:
`packages/mcp/test/agent.test.ts` › *"extrude_image warns that curve
fidelity is bounded by raster source resolution"* — asserts the live tool
description (not just the source string) mentions resolution and faceting;
fails without the fix. No behavior change — geometry, triangle counts, and
every existing fixture are untouched (`pnpm -r test` after the fix: same
177+3-skipped/2/46/5 pass counts as before it).

L12 is closed as an advice fix, not a behavior fix: the raster-resolution
ceiling itself is untouched and, on the numbers above, an inherent cost of
tracing pixels rather than a bug. A future pass could raise the default trace
ceiling or add a `next_actions`-style warning when a traced polygon looks too
coarse for its apparent curvature — that's a real, separately-scoped geometry
change with its own test surface, not something this pass measured or is
claiming here.

## Probe

No regressions vs baseline before or after the fix; latency numbers moved
within normal noise (this host, not the committed baseline — see
`docs/agent-loop/baseline.json`'s own caveat). Full markdown attached to the
PR.
