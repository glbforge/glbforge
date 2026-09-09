"""
Oracle for the pure-TS USD readers: writes a layer with Pixar's usd-core that
exercises compressed int/float arrays, time samples, quatf/half3 arrays,
references with layer offsets, variants, dictionaries and a usdz package.
Usage: python usd-reader-oracle.py <out-dir>   (needs `pip install usd-core`)
Opt-in from the vitest suite via GLBFORGE_PXR_PYTHON=<venv>/bin/python.
"""
import sys, os
os.chdir(sys.argv[1])
from pxr import Usd, UsdGeom, UsdShade, UsdSkel, Sdf, Gf, Vt, UsdUtils
import os, struct
# --- referenced layer
ref = Usd.Stage.CreateNew('ref.usda')
UsdGeom.Xform.Define(ref, '/Ref')
c = UsdGeom.Cube.Define(ref, '/Ref/Cube')
ref.SetDefaultPrim(ref.GetPrimAtPath('/Ref'))
ref.Save()
# --- main
st = Usd.Stage.CreateNew('scene.usda')
UsdGeom.SetStageUpAxis(st, 'Y'); UsdGeom.SetStageMetersPerUnit(st, 1.0)
st.SetStartTimeCode(0); st.SetEndTimeCode(48); st.SetTimeCodesPerSecond(24); st.SetFramesPerSecond(24)
root = UsdGeom.Xform.Define(st, '/Root'); st.SetDefaultPrim(root.GetPrim())
root.GetPrim().SetCustomDataByKey('glbforge', {'note': 'hello', 'n': 3})
x = UsdGeom.Xform.Define(st, '/Root/Geo')
x.AddTranslateOp().Set(Gf.Vec3d(1, 2, 3)); x.AddRotateXYZOp().Set(Gf.Vec3f(0, 90, 0)); x.AddScaleOp().Set(Gf.Vec3f(2, 2, 2))
# animated translate
tr = x.GetOrderedXformOps()[0]
tr.Set(Gf.Vec3d(0,0,0), 0); tr.Set(Gf.Vec3d(0,1,0), 24); tr.Set(Gf.Vec3d(0,0,0), 48)
# grid mesh 6x6 quads -> 36 faces, 49 verts (> 16 -> compressed arrays)
N = 7
pts = [Gf.Vec3f(i, 0, j) for j in range(N) for i in range(N)]
counts = []; idx = []
for j in range(N-1):
    for i in range(N-1):
        a = j*N+i; counts.append(4); idx += [a, a+1, a+N+1, a+N]
m = UsdGeom.Mesh.Define(st, '/Root/Geo/Grid')
m.GetPointsAttr().Set(Vt.Vec3fArray(pts)); m.GetFaceVertexCountsAttr().Set(Vt.IntArray(counts)); m.GetFaceVertexIndicesAttr().Set(Vt.IntArray(idx))
m.GetNormalsAttr().Set(Vt.Vec3fArray([Gf.Vec3f(0,1,0)]*len(pts))); m.SetNormalsInterpolation('vertex')
m.GetSubdivisionSchemeAttr().Set('none'); m.GetDoubleSidedAttr().Set(True)
pv = UsdGeom.PrimvarsAPI(m.GetPrim()).CreatePrimvar('st', Sdf.ValueTypeNames.TexCoord2fArray, 'vertex')
pv.Set(Vt.Vec2fArray([Gf.Vec2f(i/(N-1), j/(N-1)) for j in range(N) for i in range(N)]))
# float primvar with few uniques -> 't' lut compression; and integral floats -> 'i'
fp = UsdGeom.PrimvarsAPI(m.GetPrim()).CreatePrimvar('lut', Sdf.ValueTypeNames.FloatArray, 'vertex'); fp.Set(Vt.FloatArray([[0.25, 0.5][i%2] for i in range(len(pts))]))
ip = UsdGeom.PrimvarsAPI(m.GetPrim()).CreatePrimvar('ints', Sdf.ValueTypeNames.FloatArray, 'vertex'); ip.Set(Vt.FloatArray([float(i%5) for i in range(len(pts))]))
# material
mat = UsdShade.Material.Define(st, '/Root/Materials/Mat')
sh = UsdShade.Shader.Define(st, '/Root/Materials/Mat/PBRShader'); sh.CreateIdAttr('UsdPreviewSurface')
sh.CreateInput('roughness', Sdf.ValueTypeNames.Float).Set(0.4); sh.CreateInput('metallic', Sdf.ValueTypeNames.Float).Set(0.0)
tex = UsdShade.Shader.Define(st, '/Root/Materials/Mat/Tex'); tex.CreateIdAttr('UsdUVTexture')
tex.CreateInput('file', Sdf.ValueTypeNames.Asset).Set('textures/color.png'); tex.CreateInput('sourceColorSpace', Sdf.ValueTypeNames.Token).Set('sRGB')
tex.CreateOutput('rgb', Sdf.ValueTypeNames.Float3)
sh.CreateInput('diffuseColor', Sdf.ValueTypeNames.Color3f).ConnectToSource(tex.ConnectableAPI(), 'rgb')
mat.CreateSurfaceOutput().ConnectToSource(sh.ConnectableAPI(), 'surface')
UsdShade.MaterialBindingAPI.Apply(m.GetPrim()).Bind(mat)
# reference + variant
r = st.DefinePrim('/Root/Referenced'); r.GetReferences().AddReference('./ref.usda')
vs = root.GetPrim().GetVariantSets().AddVariantSet('lod'); vs.AddVariant('high'); vs.AddVariant('low'); vs.SetVariantSelection('high')
# skeleton
sr = UsdSkel.Root.Define(st, '/Root/Char')
sk = UsdSkel.Skeleton.Define(st, '/Root/Char/Skel')
sk.GetJointsAttr().Set(Vt.TokenArray(['root', 'root/upper']))
sk.GetBindTransformsAttr().Set(Vt.Matrix4dArray([Gf.Matrix4d(1), Gf.Matrix4d(1).SetTranslate(Gf.Vec3d(0,1,0))]))
sk.GetRestTransformsAttr().Set(Vt.Matrix4dArray([Gf.Matrix4d(1), Gf.Matrix4d(1).SetTranslate(Gf.Vec3d(0,1,0))]))
an = UsdSkel.Animation.Define(st, '/Root/Char/Skel/Anim'); an.GetJointsAttr().Set(Vt.TokenArray(['root', 'root/upper']))
for t in (0, 24, 48):
    an.GetTranslationsAttr().Set(Vt.Vec3fArray([Gf.Vec3f(0,0,0), Gf.Vec3f(0,1,0)]), t)
    q = Gf.Quatf(1,0,0,0) if t != 24 else Gf.Quatf(0.7071068, 0, 0, 0.7071068)
    an.GetRotationsAttr().Set(Vt.QuatfArray([Gf.Quatf(1,0,0,0), q]), t)
    an.GetScalesAttr().Set(Vt.Vec3hArray([Gf.Vec3h(1,1,1), Gf.Vec3h(1,1,1)]), t)
an.GetBlendShapesAttr().Set(Vt.TokenArray(['bulge'])); an.GetBlendShapeWeightsAttr().Set(Vt.FloatArray([0.0]), 0); an.GetBlendShapeWeightsAttr().Set(Vt.FloatArray([1.0]), 24)
UsdSkel.BindingAPI.Apply(sk.GetPrim()).CreateAnimationSourceRel().SetTargets([an.GetPath()])
tube = UsdGeom.Mesh.Define(st, '/Root/Char/Tube')
tp = [Gf.Vec3f(0,0,0), Gf.Vec3f(1,0,0), Gf.Vec3f(1,2,0), Gf.Vec3f(0,2,0)]
tube.GetPointsAttr().Set(Vt.Vec3fArray(tp)); tube.GetFaceVertexCountsAttr().Set(Vt.IntArray([3,3])); tube.GetFaceVertexIndicesAttr().Set(Vt.IntArray([0,1,2,0,2,3]))
b = UsdSkel.BindingAPI.Apply(tube.GetPrim()); b.CreateSkeletonRel().SetTargets([sk.GetPath()])
b.CreateJointIndicesPrimvar(False, 2).Set(Vt.IntArray([0,0,0,0,1,0,1,0])); b.CreateJointWeightsPrimvar(False, 2).Set(Vt.FloatArray([1,0,1,0,1,0,1,0]))
b.CreateGeomBindTransformAttr().Set(Gf.Matrix4d(1))
bs = UsdSkel.BlendShape.Define(st, '/Root/Char/Tube/bulge'); bs.GetOffsetsAttr().Set(Vt.Vec3fArray([Gf.Vec3f(0.1,0,0)]*4))
b.CreateBlendShapesAttr().Set(Vt.TokenArray(['bulge'])); b.CreateBlendShapeTargetsRel().SetTargets([bs.GetPath()])
st.GetRootLayer().Save()
st.GetRootLayer().Export('scene.usdc')
os.makedirs('textures', exist_ok=True)
# tiny 4x4 png
import zlib
def png(w,h):
    raw = b''.join(b'\x00' + bytes([200,80,40,255])*w for _ in range(h))
    def chunk(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
open('textures/color.png','wb').write(png(4,4))
ok = UsdUtils.CreateNewUsdzPackage(Sdf.AssetPath('scene.usdc'), 'scene.usdz')
print('OK usdz', ok)
