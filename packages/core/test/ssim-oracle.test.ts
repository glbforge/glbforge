import { describe, it, expect } from 'vitest';
import ssimJsDefault from 'ssim.js';
import {
  computeFrame, extrudeImage, getProfile, optimize, renderRaw, ssim, verifyRig,
} from '../src/index.js';

// ssim.js's Wang et al. reference port, run with GLBForge's own parameters
// (11x11 Gaussian, sigma 1.5, K1=0.01, K2=0.03 — see harness/perceptual.ts).
const REFERENCE_OPTS = { windowSize: 11, k1: 0.01, k2: 0.03, ssim: 'original' as const, downsample: false as const, bitDepth: 8 as const };
function referenceSsim(a: { rgba: Uint8Array; size: number }, b: { rgba: Uint8Array; size: number }) {
  return ssimJsDefault({ data: a.rgba, width: a.size, height: a.size }, { data: b.rgba, width: b.size, height: b.size }, REFERENCE_OPTS).mssim;
}

function flatView(v: number, size: number) {
  const rgba = new Uint8Array(size * size * 4);
  const mask = new Uint8Array(size * size).fill(1);
  for (let i = 0; i < size * size; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; }
  return { name: 'flat', rgba, mask, size, camera: { position: [0, 0, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number], fovDeg: 40 } };
}

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
async function ring() {
  return (await extrudeImage(await ringPng(), { texture: false, pillow: 0.04 })).doc;
}

// Cross-checks the core windowed-SSIM math (harness/perceptual.ts's own
// `ssim()`) against an independent, published implementation — a rival pass
// asked "does the metric that gates optimize()'s no-visible-loss claim agree
// with a reference SSIM library?".
describe('SSIM cross-check against a reference implementation (ssim.js)', () => {
  it('matches the reference exactly on a full-coverage luminance-only shift (isolates the C1/C2 term)', () => {
    // Flat images have zero local variance, so this exercises only the
    // luminance term and the Gaussian-window plumbing, with no boundary or
    // masking effects (every pixel is "covered").
    const size = 64;
    const a = flatView(120, size);
    for (const shift of [5, 20, 60, 120]) {
      const b = flatView(Math.min(255, 120 + shift), size);
      const glb = ssim(a, b).ssim;
      const ref = referenceSsim(a, b);
      expect(glb).toBeCloseTo(ref, 5);
    }
  });

  it('stays within ~0.02 of the reference on a full-coverage structural shift', () => {
    // A checkerboard has local variance, so this exercises the covariance
    // term too. Some divergence from the reference is expected here — the
    // reference implementation crops a windowSize/2 border ("valid"
    // convolution) while GLBForge clamps at the edge to score every pixel
    // (see harness/perceptual.ts) — but it should stay small.
    const size = 64;
    function checker(amp: number, phase: number) {
      const rgba = new Uint8Array(size * size * 4);
      const mask = new Uint8Array(size * size).fill(1);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const v = 128 + amp * ((((x + phase) % 4 < 2) !== (y % 4 < 2)) ? 1 : -1);
        const i = (y * size + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = Math.max(0, Math.min(255, v)); rgba[i + 3] = 255;
      }
      return { name: 'checker', rgba, mask, size, camera: { position: [0, 0, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number], fovDeg: 40 } };
    }
    const a = checker(60, 0);
    const b = checker(60, 1); // a small phase shift — plausible dissimilarity, not the pathological full inversion below
    const glb = ssim(a, b).ssim;
    const ref = referenceSsim(a, b);
    expect(Math.abs(glb - ref)).toBeLessThan(0.02);
  });

  it('clamps to 0 instead of reporting negative SSIM on a pathological structural inversion', () => {
    // A phase-2 shift of the same checkerboard is a perfect structural
    // inversion — every window anti-correlates. The reference implementation
    // reports that as a large negative number; GLBForge's ssim() floors the
    // mean at 0 (harness/perceptual.ts: `Math.min(1, Math.max(0, sum /
    // count))`). This never occurs on real renders of similar geometry (no
    // GLBForge render pair is a coherent structural inversion of another),
    // and it doesn't change any pass/fail verdict — both "very different"
    // and "adversarially inverted" already fail every profile's minSsim
    // floor — but the two are indistinguishable in the reported number.
    const size = 64;
    function checker(phase: number) {
      const rgba = new Uint8Array(size * size * 4);
      const mask = new Uint8Array(size * size).fill(1);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const v = 128 + 60 * ((((x + phase) % 4 < 2) !== (y % 4 < 2)) ? 1 : -1);
        const i = (y * size + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = Math.max(0, Math.min(255, v)); rgba[i + 3] = 255;
      }
      return { name: 'checker', rgba, mask, size, camera: { position: [0, 0, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number], fovDeg: 40 } };
    }
    const a = checker(0);
    const b = checker(2);
    const glb = ssim(a, b).ssim;
    const ref = referenceSsim(a, b);
    expect(glb).toBe(0);
    expect(ref).toBeLessThan(-0.9);
  });

  it('scores real decimation meaningfully lower than a naive full-frame reference would — the masking design pays off', async () => {
    // harness/perceptual.ts's docstring claims the union-mask design exists
    // "so a small object on a large identical background can't coast to a
    // high score". This measures that claim against an oracle that doesn't
    // mask: a reference SSIM over the *entire* frame, background included.
    const reference = await ring();
    const harsh = await ring();
    await optimize(harsh, { profile: getProfile('mobile-hero'), targetTriangles: 300, textures: false, compress: false, verify: false });

    const frame = await computeFrame(reference);
    const cams = verifyRig();
    const refViews = await renderRaw(reference, { size: 128, cameras: cams, frame });
    const candViews = await renderRaw(harsh, { size: 128, cameras: cams, frame });

    for (let i = 0; i < refViews.length; i++) {
      const glb = ssim(refViews[i], candViews[i]).ssim;
      const naive = referenceSsim(refViews[i], candViews[i]);
      // The naive full-frame score is inflated by identical background
      // pixels the masked score correctly excludes.
      expect(naive).toBeGreaterThan(glb + 0.02);
    }
  }, 60_000);
});
