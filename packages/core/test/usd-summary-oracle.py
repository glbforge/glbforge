"""Oracle for toUsdz()'s own reported summary (meshes/triangles/materials/textures),
cross-checked against Pixar's reference reader on a real production asset --
every other USD oracle in this repo only exercises small hand-built fixtures.
Usage: python usd-summary-oracle.py <file.usdz>   (needs `pip install usd-core`)
Opt-in from the vitest suite via GLBFORGE_PXR_PYTHON=<venv>/bin/python.
Prints one JSON line: {"meshes":N,"triangles":N,"materials":N,"textures":N}."""
import json, sys
from pxr import Usd, UsdGeom, UsdShade

stage = Usd.Stage.Open(sys.argv[1])
if not stage:
    print(f'FAIL: Pixar USD could not open {sys.argv[1]}', file=sys.stderr)
    sys.exit(1)

meshes = 0
triangles = 0
bound_materials = set()
textures = set()
errors = []
for prim in stage.Traverse():
    if prim.IsA(UsdGeom.Mesh):
        meshes += 1
        mesh = UsdGeom.Mesh(prim)
        counts = mesh.GetFaceVertexCountsAttr().Get()
        if counts is None:
            errors.append(f'{prim.GetPath()}: no faceVertexCounts')
            continue
        for c in counts:
            if c == 3:
                triangles += 1
            else:
                errors.append(f'{prim.GetPath()}: non-triangle face (n={c})')
        targets = UsdShade.MaterialBindingAPI(prim).GetDirectBindingRel().GetTargets()
        for t in targets:
            bound_materials.add(str(t))
    if prim.IsA(UsdShade.Shader):
        file_input = UsdShade.Shader(prim).GetInput('file')
        if file_input is not None:
            v = file_input.Get()
            if v is not None:
                textures.add(str(v.path if hasattr(v, 'path') else v))

if errors:
    print('\n'.join(errors[:20]), file=sys.stderr)
    sys.exit(2)

print(json.dumps({
    'meshes': meshes,
    'triangles': triangles,
    'materials': len(bound_materials),
    'textures': len(textures),
}))
