"""Compare a GLBForge usdz/usdc against a usda twin using Pixar's USD (the reference reader).
Usage: python usd-oracle.py <candidate.usdz|usdc> <reference.usdz|usda>
Exit 0 when every prim, attribute value, connection, relationship, and layer metadata matches.
Requires the `usd-core` wheel (pip install usd-core)."""
import math, sys
from pxr import Usd, Sdf, Gf, UsdSkel

cand_path, ref_path = sys.argv[1], sys.argv[2]
cand = Usd.Stage.Open(cand_path)
ref = Usd.Stage.Open(ref_path)
errors = []

def same(a, b, where):
    if isinstance(a, Sdf.AssetPath) and isinstance(b, Sdf.AssetPath):
        a, b = a.path, b.path  # resolved paths embed the package file name
    if isinstance(a, (Gf.Quatf, Gf.Quatd, Gf.Quath)) and isinstance(b, (Gf.Quatf, Gf.Quatd, Gf.Quath)):
        a, b = [a.GetReal(), *a.GetImaginary()], [b.GetReal(), *b.GetImaginary()]
    if isinstance(a, (float, int)) and isinstance(b, (float, int)) and not isinstance(a, bool):
        if not math.isclose(float(a), float(b), rel_tol=1e-6, abs_tol=1e-6): errors.append(f'{where}: {a} != {b}')
        return
    if hasattr(a, '__len__') and hasattr(b, '__len__') and not isinstance(a, str):
        if len(a) != len(b): errors.append(f'{where}: length {len(a)} != {len(b)}'); return
        for i, (x, y) in enumerate(zip(a, b)):
            same(x, y, f'{where}[{i}]')
            if len(errors) > 20: return
        return
    if a != b: errors.append(f'{where}: {a!r} != {b!r}')

for key in ('defaultPrim', 'metersPerUnit', 'upAxis', 'documentation'):
    same(cand.GetMetadata(key) if cand.HasMetadata(key) else None,
         ref.GetMetadata(key) if ref.HasMetadata(key) else None, f'layer.{key}')

ref_prims = list(ref.Traverse())
cand_prims = {str(p.GetPath()): p for p in cand.Traverse()}
if len(cand_prims) != len(ref_prims): errors.append(f'prim count {len(cand_prims)} != {len(ref_prims)}')
for rp in ref_prims:
    cp = cand_prims.get(str(rp.GetPath()))
    if cp is None: errors.append(f'missing prim {rp.GetPath()}'); continue
    same(cp.GetTypeName(), rp.GetTypeName(), f'{rp.GetPath()}.typeName')
    same(list(cp.GetAppliedSchemas()), list(rp.GetAppliedSchemas()), f'{rp.GetPath()}.apiSchemas')
    same([c.GetName() for c in cp.GetChildren()], [c.GetName() for c in rp.GetChildren()], f'{rp.GetPath()}.children')
    same([p.GetName() for p in cp.GetProperties()], [p.GetName() for p in rp.GetProperties()], f'{rp.GetPath()}.properties')
    for ra in rp.GetAttributes():
        ca = cp.GetAttribute(ra.GetName())
        if not ca: errors.append(f'missing attr {ra.GetPath()}'); continue
        same(str(ca.GetTypeName()), str(ra.GetTypeName()), f'{ra.GetPath()}.type')
        same(ca.GetVariability(), ra.GetVariability(), f'{ra.GetPath()}.variability')
        same(list(ca.GetConnections()), list(ra.GetConnections()), f'{ra.GetPath()}.connections')
        same(ca.GetMetadata('interpolation'), ra.GetMetadata('interpolation'), f'{ra.GetPath()}.interpolation')
        same(ca.GetMetadata('elementSize'), ra.GetMetadata('elementSize'), f'{ra.GetPath()}.elementSize')
        rv, cv = ra.Get(), ca.Get()
        if (rv is None) != (cv is None): errors.append(f'{ra.GetPath()}: value presence {cv is not None} != {rv is not None}')
        elif rv is not None: same(cv, rv, f'{ra.GetPath()}.value')
        rt, ct = list(ra.GetTimeSamples()), list(ca.GetTimeSamples())
        same(ct, rt, f'{ra.GetPath()}.timeSamples')
        for t in rt[:: max(1, len(rt) // 6)]:
            same(ca.Get(t), ra.Get(t), f'{ra.GetPath()}@{t}')
    for rr in rp.GetRelationships():
        cr = cp.GetRelationship(rr.GetName())
        if not cr: errors.append(f'missing rel {rr.GetPath()}'); continue
        same(list(cr.GetTargets()), list(rr.GetTargets()), f'{rr.GetPath()}.targets')

# UsdSkel sanity on the candidate: valid skeleton + animation queries, and the last joint's local rotation at the end frame.
for prim in cand.Traverse():
    if prim.IsA(UsdSkel.Skeleton):
        q = UsdSkel.Cache().GetSkelQuery(UsdSkel.Skeleton(prim))
        if not q: errors.append(f'{prim.GetPath()}: invalid skeleton query'); continue
        aq = q.GetAnimQuery()
        joints = list(q.GetJointOrder())
        frames = len(aq.GetJointTransformTimeSamples()) if aq else 0
        rot = ''
        if aq:
            xf = q.ComputeJointLocalTransforms(cand.GetEndTimeCode())
            m = xf[-1]; rq = m.ExtractRotationQuat()
            rot = f' upper@{int(cand.GetEndTimeCode())}=({rq.GetReal():.4g}, ' + ', '.join(f'{c:.4g}' for c in rq.GetImaginary()) + ')'
        bs = ''
        if aq:
            names = list(aq.GetBlendShapeOrder())
            if names:
                w = aq.ComputeBlendShapeWeights(15)
                bs = f' blendShapes={len(names)} weight@15={w[0]:.4g}'
                # every mesh bound to this skeleton must resolve its blend shapes
                for mp in cand.Traverse():
                    b = UsdSkel.BindingAPI(mp)
                    if mp.HasAPI(UsdSkel.BindingAPI) and b.GetBlendShapesAttr().HasAuthoredValue():
                        targets = b.GetBlendShapeTargetsRel().GetTargets()
                        if len(targets) != len(b.GetBlendShapesAttr().Get()): errors.append(f'{mp.GetPath()}: blendShapes/targets length mismatch')
                        for tp in targets:
                            if not cand.GetPrimAtPath(tp).IsA(UsdSkel.BlendShape): errors.append(f'{tp}: not a BlendShape')
        print(f'skel: joints={len(joints)} frames={frames}{rot}{bs}')
if errors:
    print('\n'.join(errors[:40])); print(f'{len(errors)} difference(s)'); sys.exit(1)
print(f'OK: {len(ref_prims)} prims identical between {cand_path} and {ref_path}')
