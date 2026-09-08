import { describe, it, expect } from 'vitest';
import { Document } from '@gltf-transform/core';
import {
  analyze, applyPerceptualVerdict, computeFrame, extrudeImage, getProfile, optimize,
  perceptualDiff, readFloat, renderRaw, verifyRig, PERCEPTUAL_RULE,
} from '../src/index.js';

async function ringPng(): Promise<Uint8Array> {
  const sharp = (await import('sharp')).default;
  const size = 96;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot(x - 48, y - 48);
    if (r < 36 && r > 14) { const i = (y * size + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 255; }
  }
  return new Uint8Array(await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer());
}

async function ring(): Promise<Document> {
  const { doc } = await extrudeImage(await ringPng(), { texture: false, pillow: 0.04 });
  return doc;
}

describe('perceptual verification', () => {
  it('renders deterministically and scores identity as exactly 1', async () => {
    const a = await ring();
    const b = await ring();
    const frame = await computeFrame(a);
    const va = await renderRaw(a, { size: 128, cameras: verifyRig(), frame });
    const vb = await renderRaw(b, { size: 128, cameras: verifyRig(), frame });
    expect(Buffer.from(va[0].rgba).equals(Buffer.from(vb[0].rgba))).toBe(true);
    expect(va[0].mask.reduce((s, m) => s + m, 0)).toBeGreaterThan(1000); // the object is actually in frame

    const same = await perceptualDiff(a, b, { size: 128 });
    expect(same.ssimMin).toBe(1);
    expect(same.views).toHaveLength(4);
  });

  it('ranks heavier decimation as visibly lossier', async () => {
    const reference = await ring();
    const mild = await ring();
    await optimize(mild, { profile: getProfile('mobile-hero'), targetTriangles: 4000, textures: false, compress: false, verify: false });
    const harsh = await ring();
    await optimize(harsh, { profile: getProfile('mobile-hero'), targetTriangles: 300, textures: false, compress: false, verify: false });

    const mildScore = await perceptualDiff(reference, mild, { size: 128 });
    const harshScore = await perceptualDiff(reference, harsh, { size: 128 });
    expect(mildScore.ssimMin).toBeLessThanOrEqual(1);
    expect(harshScore.ssimMin).toBeLessThan(mildScore.ssimMin);
    expect(harshScore.ssimMin).toBeLessThan(0.97); // 300 tris of a beveled ring is visibly polygonal
  }, 60_000);

  it('keeps the camera fixed to the reference frame when bounds shift', async () => {
    const reference = await ring();
    const shifted = await ring();
    shifted.getRoot().listNodes()[0].setTranslation([0.3, 0, 0]);
    const moved = await perceptualDiff(reference, shifted, { size: 128 });
    expect(moved.ssimMin).toBeLessThan(0.9); // a shift must NOT be hidden by re-framing
  });

  it('optimize() reports a verdict against the profile floor', async () => {
    const doc = await ring();
    const profile = getProfile('mobile-hero');
    const summary = await optimize(doc, { profile, targetTriangles: 4000, textures: false, compress: false });
    expect(summary.perceptual).not.toBeNull();
    expect(summary.perceptual!.threshold).toBe(profile.minSsim);
    expect(summary.perceptual!.views.map((v) => v.name)).toEqual(['verify_45', 'verify_135', 'verify_225', 'verify_315']);
    expect(summary.steps.some((s) => s.startsWith('verify ssim='))).toBe(true);

    const skipped = await optimize(await ring(), { profile, textures: false, compress: false, verify: false });
    expect(skipped.perceptual).toBeNull();
  }, 60_000);

  it('folds the verdict into the report card', async () => {
    const doc = await ring();
    const profile = getProfile('mobile-hero');
    const base = { ssimMean: 0.9, ssimMin: 0.85, worstView: 'verify_135', views: [], textured: false, size: 256, threshold: 0.95 };

    const failing = applyPerceptualVerdict(analyze(doc, { profile }), { ...base, passed: false });
    const err = failing.findings.find((f) => f.ruleId === PERCEPTUAL_RULE)!;
    expect(err.severity).toBe('error');
    expect(failing.passed).toBe(false);
    expect(err.message).toContain('85.0%');

    const passing = applyPerceptualVerdict(analyze(doc, { profile }), { ...base, ssimMin: 0.99, ssimMean: 0.995, passed: true });
    expect(passing.findings.find((f) => f.ruleId === PERCEPTUAL_RULE)!.severity).toBe('info');
    expect(passing.passed).toBe(true);
  });
});

describe('readFloat', () => {
  it('denormalizes KHR_mesh_quantization integer accessors', () => {
    const doc = new Document();
    const acc = doc.createAccessor().setType('VEC3').setArray(new Int16Array([32767, -32767, 0])).setNormalized(true);
    expect(Array.from(readFloat(acc))).toEqual([1, -1, 0]);
    const uv = doc.createAccessor().setType('VEC2').setArray(new Uint16Array([65535, 0])).setNormalized(true);
    expect(Array.from(readFloat(uv))).toEqual([1, 0]);
    const plain = doc.createAccessor().setType('SCALAR').setArray(new Uint16Array([7]));
    expect(Array.from(readFloat(plain))).toEqual([7]);
  });
});
