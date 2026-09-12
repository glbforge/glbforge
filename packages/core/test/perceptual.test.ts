import { describe, it, expect } from 'vitest';
import { Document } from '@gltf-transform/core';
import {
  analyze, applyPerceptualVerdict, computeFrame, extrudeImage, getProfile, linearToSrgb,
  optimize, perceptualDiff, readFloat, renderRaw, sharpTextureDecoder, srgbToLinear,
  verifyRig, PERCEPTUAL_RULE,
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

/**
 * glTF stores base color in two slots with two encodings — a LINEAR
 * `baseColorFactor` and an sRGB-encoded texture — and the pipeline moves
 * colour between them on its own: `prune()` folds a texture that is one solid
 * colour into the factor and drops the image. The delivered asset is correct
 * and smaller, so the renderer that scores it must see no change at all. It
 * used to see a large one, because it sampled texels as if they were already
 * linear: a surface scored across two different transfer curves reported
 * visible loss that did not exist.
 *
 * These tests own that contract directly, on documents built here — not
 * through whatever the extruder currently emits, which is what made the
 * original bug hide behind an unrelated forge change.
 */
describe('base color transfer curves', () => {
  const SRGB: [number, number, number] = [80, 180, 255];

  /**
   * Alpha carves the silhouette while RGB is constant across the whole image,
   * so the walls and bevels cannot sample a different texel than the face:
   * the only difference between the two documents is which slot holds the
   * colour.
   */
  async function bledPng(rgb: [number, number, number], size = 64): Promise<Uint8Array> {
    const sharp = (await import('sharp')).default;
    const rgba = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      rgba[i] = rgb[0]; rgba[i + 1] = rgb[1]; rgba[i + 2] = rgb[2];
      rgba[i + 3] = Math.hypot(x - size / 2, y - size / 2) < size * 0.4 ? 255 : 0;
    }
    return new Uint8Array(await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer());
  }

  const linear = (rgb: [number, number, number]) =>
    rgb.map((c) => srgbToLinear(c / 255)) as [number, number, number];

  it('scores a solid texture and the factor it folds into as identical', async () => {
    const png = await bledPng(SRGB);
    const textured = (await extrudeImage(png, { texture: true })).doc;
    const folded = (await extrudeImage(png, { texture: false, color: [...linear(SRGB), 1] })).doc;
    const r = await perceptualDiff(textured, folded, { size: 128, textureDecoder: sharpTextureDecoder() });
    expect(r.ssimMin).toBe(1); // 0.9045 when texels were sampled as linear
  }, 60_000);

  it('composes factor * texture the way glTF defines it', async () => {
    // A white texture must be a no-op over the factor, not a replacement for it.
    const white = await bledPng([255, 255, 255]);
    const overFactor = (await extrudeImage(white, { texture: true, color: [...linear(SRGB), 1] })).doc;
    overFactor.getRoot().listMaterials()[0].setBaseColorFactor([...linear(SRGB), 1]);
    const factorOnly = (await extrudeImage(white, { texture: false, color: [...linear(SRGB), 1] })).doc;
    const r = await perceptualDiff(overFactor, factorOnly, { size: 128, textureDecoder: sharpTextureDecoder() });
    expect(r.ssimMin).toBe(1);
  }, 60_000);

  it('writes display-referred sRGB, so an unlit-bright texel survives the round trip', async () => {
    const png = await bledPng(SRGB);
    const { doc } = await extrudeImage(png, { texture: true });
    const frame = await computeFrame(doc);
    const [view] = await renderRaw(doc, {
      size: 96, cameras: verifyRig().slice(0, 1), frame, textureDecoder: sharpTextureDecoder(),
    });
    // The rasterizer's ambient+lambert term never exceeds 1, so no covered
    // pixel may be brighter than the texel itself — and the brightest one
    // should be close to it rather than a gamma-squashed fraction.
    let brightest = 0;
    for (let i = 0; i < view.size * view.size; i++) if (view.mask[i]) brightest = Math.max(brightest, view.rgba[i * 4 + 2]);
    expect(brightest).toBeLessThanOrEqual(SRGB[2]);
    expect(brightest).toBeGreaterThan(SRGB[2] * 0.9);
  }, 60_000);

  it('round-trips the transfer function it shades with', () => {
    for (const byte of [0, 1, 24, 80, 128, 180, 254, 255]) {
      expect(Math.round(linearToSrgb(srgbToLinear(byte / 255)) * 255)).toBe(byte);
    }
    expect(srgbToLinear(80 / 255)).toBeCloseTo(0.0802, 4); // the value prune() writes for (80,180,255)
    expect(srgbToLinear(180 / 255)).toBeCloseTo(0.4564, 4);
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
