# Pass — 2026-09-26 — 8b223a6
**Role:** rival

## Step 0 — claim check

```
gh pr list --state open --json number,title,headRefName --jq '.[] | select(.headRefName | startswith("agent-loop/"))'
```

16 open `agent-loop/`-prefixed PRs (#20, #29, #30, #31, #32, #34, #37, #38,
#39, #40, #42, #43, #44, #45), plus one non-`agent-loop/`-prefixed PR (#41,
`ci/usd-oracle`). Seven of those are already `rival` passes: #28
(gltf-transform/gltfpack vs. `optimize()` on size), #38 (Khronos
gltf-validator vs. spec conformance), #39 (Manifold oracle vs. the
"watertight" claim), #40 (ssim.js vs. the SSIM gate), #42 (gltfpack vs.
`buildLod`'s cluster fallback), #44 (Draco vs. meshopt), #45 (three.js
`ExtrudeGeometry` vs. `extrude_image`). None of them touch `glbforge
scaffold` or compare against a component generator — the closest is #29
(`integrator`, fixes a `KTX2Loader` type mismatch and a silent
`pnpm install` no-op inside a host workspace in the same file,
`scaffold.ts`), which is a different, narrower claim (the emitted project
fails its own build script / installs nothing) than what this pass measures
(what the emitted *code* lets an agent do once it does build). Read #29's
diff before touching `scaffold.ts` to avoid restating its fix or its two
findings.

## Ground truth

`pnpm install && pnpm -r build`: clean, 6 packages. `pnpm -r test` (before
any change): core 21 files / 177 passed / 3 skipped, meshy clean, studio
2/2, cli 5/5 + 5 skipped, mcp 46/46 — all green. `pnpm probe -- --no-live`:
28 tools, no baseline regressions; the only flagged item is the known `L4`
(`site/llms.txt` "0.9.0 line" vs. 0.8.0 packages) — a release decision,
already `open` on the ledger, left alone.

## Role

`pnpm ledger` printed `rival` — never used going into today, and (per Step
0) heavily used by same-day unmerged PRs already. Read `ROLES.md`: install a
real alternative, run a real asset through both, publish a table where
GLBForge sometimes loses.

## The rivals

`glbforge scaffold <file> -o <dir>` (`packages/cli/src/scaffold.ts`) against
`gltfjsx@6.5.3` (npm `gltfjsx`, the pmndrs/react-three-fiber ecosystem's own
GLB→JSX generator — install clean, no other network needed). Four real,
non-LFS, checked-in assets, not synthetic: `assets/sample-ring.glb` (1 mesh)
and three from `site/models/` — `cat.glb` (1 mesh, PBR texture), `plush.glb`
and `neon.glb` (GLBForge's own layered-forge output: `extrudeImage({ layers:
'auto' })` gives each flat-coloured layer its own mesh node and material —
`glbforge inspect site/models/plush.glb` confirms 4 mesh nodes named
`layer-0`..`layer-3`, 4 materials, one per node).

## What each one emits

`gltfjsx --types` on `plush.glb`:

```tsx
type GLTFResult = GLTF & {
  nodes: { ['layer-0']: THREE.Mesh; ['layer-1']: THREE.Mesh; /* … */ }
  materials: { ['layer-0']: THREE.MeshStandardMaterial; /* … */ }
}
export function Model(props: JSX.IntrinsicElements['group']) {
  const { nodes, materials } = useGLTF('/plush.glb') as GLTFResult
  return (
    <group {...props} dispose={null}>
      <mesh geometry={nodes['layer-0'].geometry} material={materials['layer-0']} position={[0.008, -0.008, 0]} scale={0.443} />
      {/* one <mesh> per layer, each individually addressable */}
    </group>
  )
}
```

`glbforge scaffold plush.glb -o viewer` (pre-fix, `main`'s current
`App.tsx`):

```tsx
function Model() {
  const { scene } = useGLTF('/model.glb', true, true, (loader) => { /* KTX2 */ });
  return <primitive object={scene} />;
}
```

## The finding

`useGLTF` (drei, wrapping three-stdlib's `GLTFLoader`) parses the exact same
`nodes`/`materials` maps gltfjsx prints — that's runtime behaviour of the
loader, not something gltfjsx invents. GLBForge's scaffold just never told
the agent reading the file that `layer-0`..`layer-3` (or any other node)
exist or that `nodes`/`materials` are sitting in the same destructure one
edit away. An agent asked a normal follow-up task — "make `layer-2` glow
on hover", "recolor one layer of this forged sticker" — gets a file that
looks complete, has no per-part hook, and gives no hint that one exists.
The only way to learn the name `layer-2` from the tool itself is a separate
`glbforge inspect` call the scaffold command never suggests; without it,
the agent either guesses at `scene.traverse` and a name it's read nowhere,
or greps the raw GLB's JSON chunk for `"name"` strings by hand. Confirmed
this is not `#29`'s territory: `#29`'s two findings are about the emitted
*project* failing to install/build; this is about what the emitted *code*
lets an agent do once it does build, and neither of `#29`'s two diffs
(`KTX2Loader` import source, the printed `--ignore-workspace` flag) touches
the `Model()`/`App.tsx` body this pass changes.

### L12 · `fixed` · `glbforge scaffold`'s emitted viewer named none of the asset's mesh nodes, so hooking up one part needed a separate `inspect` call the tool never suggested

Fixed in `packages/cli/src/scaffold.ts`: `scaffoldViewer` now reads the
input GLB with `@glbforge/core`'s `createNodeIO()` (already a workspace
dependency; the pattern `packages/cli/src/index.ts` already uses for every
other command) and lists the default scene's mesh-bearing node names before
writing `App.tsx`. The generated file gets a comment naming them and
pointing at the exact one-line change that makes one addressable:

```
// This asset has 4 named mesh nodes: layer-0, layer-1, layer-2, layer-3.
// useGLTF's return also carries `nodes`/`materials` maps keyed by these
// names — to hook up interaction on one part instead of the whole scene,
// destructure them alongside `scene` and render that node directly:
//   const { scene, nodes, materials } = useGLTF(...);
//   <primitive object={nodes['layer-0']} material={materials['layer-0']} onPointerOver={...} />
```

A single-mesh asset (`sample-ring.glb`) gets the one-line form: `// This
asset's one mesh node is named "extrusion".` — still useful (no `inspect`
round trip needed), never wrong (an empty scene emits no comment at all
rather than a false claim).

New test `packages/cli/test/scaffold-node-names.test.ts`: scaffolds
`plush.glb` and asserts the four layer names and the `nodes, materials`
destructure appear in `App.tsx`; scaffolds `sample-ring.glb` and asserts
`"extrusion"` appears. Confirmed red before the fix (`git stash` on just
`scaffold.ts`, reran — both assertions failed, `"extrusion"` not found in
the un-annotated file) and green after. `pnpm -r build && pnpm -r test`
clean afterward (core 177/3skip, meshy clean, studio 2/2, cli 7/5skip —
+2 new, mcp 46/46). `pnpm probe -- --no-live` unchanged (`scaffold` isn't
an MCP tool, so the probe's surface doesn't move) — no baseline
regressions.

### L13 · `open` · `glbforge scaffold` still has no typed, destructured per-node access — the comment names the gap, it doesn't close it

L12 tells an agent the names exist and the one-line pattern to use them;
it does not generate the typed `nodes`/`materials` shape or rewrite
`<primitive object={scene} />` into one `<mesh>` per node the way gltfjsx
does. Doing that properly means picking valid TS identifiers for
dash/space-containing names (`layer-0` needs `nodes['layer-0']`, gltfjsx's
own bracket-access fallback for exactly this reason), deciding what happens
to the LOD-chain branch (`modelWithLods`, which already keys a `materials`
record by node name internally — see `packages/cli/src/scaffold.ts`'s
existing `useMemo` block), and probably a `--types` flag mirroring
gltfjsx's own. That's a real feature, not a one-line fix, and closer to
gltfjsx's whole reason to exist than to a bug in GLBForge's scaffold — left
to whoever picks it up next (rival or newcomer) rather than rushed into
this pass on top of an already-in-flight PR touching the same file.

## Where GLBForge wins

Not a one-sided loss. `gltfjsx <file>` emits one `.tsx` file and nothing
else — no `package.json`, no `vite.config.ts`, no `index.html`; the
project around it is left entirely to the agent. `glbforge scaffold` emits
a complete, installable Vite project, wires the KTX2 transcoder path
(`postinstall` copies `three/examples/jsm/libs/basis` into `public/basis`,
`three-stdlib`'s `KTX2Loader` configured against it) automatically, and
picks up a `glbforge optimize --lods` sibling chain into a `<Detailed>`
LOD switch with shared materials — gltfjsx has no equivalent for any of
the three (confirmed against its own `--help`: `--transform` optimizes the
mesh itself via Draco/prune/resize, there's no scaffolding flag at all).
An agent that already has a project and wants one component embedded is
better served by gltfjsx; one that has only a GLB and wants something
running is better served by `glbforge scaffold`.

## Left open

- L13 above — full typed per-node access, deferred as a larger feature.
- Didn't test either tool against a KTX2-compressed asset (none of the
  non-LFS fixtures are KTX2-encoded, and generating one is out of scope for
  a comparison pass) — `glbforge scaffold`'s KTX2 wiring is asserted from
  reading the code, not measured here against a rival on that specific
  axis.
- Didn't chase `#29`'s two findings (KTX2Loader import type, workspace
  install flag) — confirmed still present on `main` (KTX2Loader still
  imports from `three/examples/jsm`), but claimed by that PR; left
  untouched per the loop's own no-duplicate rule.
