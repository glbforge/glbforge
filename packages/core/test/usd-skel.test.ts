import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compose, decompose, invert, mul, toUsdz, writeUsda } from '../src/index.js';
import { buildUsdLayer } from '../src/usdz.js';
import { listZip } from '../src/zip.js';
import { makeRiggedCylinder } from './fixtures.js';

describe('UsdSkel export', () => {
  it('matrix helpers round-trip', () => {
    const m = compose([1, 2, 3], [0, 0, Math.SQRT1_2, Math.SQRT1_2], [2, 2, 2]);
    const d = decompose(m);
    expect(d.t).toEqual([1, 2, 3]);
    expect(d.s.map((x) => +x.toFixed(6))).toEqual([2, 2, 2]);
    expect(d.q.map((x) => +x.toFixed(6))).toEqual([0, 0, 0.707107, 0.707107]);
    const id = mul(m, invert(m)).map((x) => +x.toFixed(6));
    expect(id).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it('writes a SkelRoot with a parents-first skeleton, bindings, and a 30 fps sampled clip', async () => {
    const doc = makeRiggedCylinder();
    const warnings: string[] = [];
    const { layer } = buildUsdLayer(doc, new Map(), { warnings });
    expect(layer.prims[0].typeName).toBe('SkelRoot');
    expect(layer.endTimeCode).toBe(30);           // 1 s clip at 30 fps → frames 0..30
    expect(layer.timeCodesPerSecond).toBe(30);
    const skel = layer.prims[0].children.find((p) => p.typeName === 'Skeleton')!;
    const joints = skel.properties.find((p) => p.name === 'joints') as { value: string[] };
    expect(joints.value).toEqual(['root', 'root/upper']);
    const rest = skel.properties.find((p) => p.name === 'restTransforms') as { value: Float64Array };
    expect(Array.from(rest.value.subarray(28, 31))).toEqual([0, 1, 0]); // upper is 1 m above root
    const anim = skel.children.find((p) => p.typeName === 'SkelAnimation')!;
    const rot = anim.properties.find((p) => p.name === 'rotations') as { samples: { times: number[]; values: Float32Array[] } };
    expect(rot.samples.times.length).toBe(31);
    const last = rot.samples.values[30];
    // upper: 90° about z at t = 1 s → (x,y,z,w) = (0, 0, 0.707, 0.707); root stays identity.
    expect(Array.from(last.subarray(0, 4)).map((x) => +x.toFixed(3))).toEqual([0, 0, 0, 1]);
    expect(Array.from(last.subarray(4, 8)).map((x) => +x.toFixed(3))).toEqual([0, 0, 0.707, 0.707]);
    const mesh = layer.prims[0].children.find((p) => p.typeName === 'Mesh')!;
    expect(mesh.apiSchemas).toContain('SkelBindingAPI');
    const ji = mesh.properties.find((p) => p.name === 'primvars:skel:jointIndices') as { elementSize: number; value: Int32Array };
    expect(ji.elementSize).toBe(4);
    expect(ji.value.length).toBe(24 * 32 * 4);
    expect(mesh.properties.some((p) => p.kind === 'relationship' && p.name === 'skel:skeleton')).toBe(true);
    expect(warnings.join(' ')).toMatch(/morph targets/);

    const usda = writeUsda(layer);
    expect(usda).toContain('def SkelRoot');
    expect(usda).toContain('quatf[] rotations.timeSamples = {');
    expect(usda).toContain('elementSize = 4');
    expect(usda).toMatch(/30: \[\(1, 0, 0, 0\), \(0\.7071068, 0, 0, 0\.7071068\)\]/); // usda prints (w, x, y, z)
  });

  it('packs both layer formats deterministically and the oracle agrees (needs GLBFORGE_PXR_PYTHON)', async () => {
    const doc = makeRiggedCylinder();
    const a = await toUsdz(doc, { textureEncoder: async ({ bytes }) => ({ bytes, mimeType: 'image/png' }) });
    const b = await toUsdz(doc, { textureEncoder: async ({ bytes }) => ({ bytes, mimeType: 'image/png' }) });
    expect(Buffer.from(a.usdz).equals(Buffer.from(b.usdz))).toBe(true);
    expect(a.skeletons).toBe(1);
    expect(a.frames).toBe(31);
    expect(listZip(a.usdz)[0].name).toBe('model.usdc');

    const python = process.env.GLBFORGE_PXR_PYTHON;
    if (!python) return;
    const txt = await toUsdz(doc, { format: 'usda', textureEncoder: async ({ bytes }) => ({ bytes, mimeType: 'image/png' }) });
    const dir = await mkdtemp(join(tmpdir(), 'glbforge-skel-'));
    try {
      await writeFile(join(dir, 'bin.usdz'), a.usdz);
      await writeFile(join(dir, 'txt.usdz'), txt.usdz);
      let out = '';
      try {
        out = execFileSync(python, [new URL('./usd-oracle.py', import.meta.url).pathname, join(dir, 'bin.usdz'), join(dir, 'txt.usdz')], { encoding: 'utf8' });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        throw new Error(`usd-oracle failed:\n${e.stdout ?? ''}\n${(e.stderr ?? '').split('\n').slice(-6).join('\n')}`);
      }
      expect(out).toMatch(/^OK:/m);
      expect(out).toMatch(/skel: joints=2 frames=31 upper@30=\(0\.7071?\d*, 0, 0, 0\.7071?\d*\)/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
