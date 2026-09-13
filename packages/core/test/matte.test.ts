import { describe, it, expect } from 'vitest';
import { extrudeFromRgba, liftSubject, tuneMatte, MATTE_VERSION } from '../src/index.js';

/**
 * Synthetic scenes, because the point of each case is one property of the
 * matte — a hole, a crop, a texture — and a real photograph mixes all of them.
 * `noise` is a deterministic hash, never Math.random: the whole pipeline's
 * contract is that the same input produces the same bytes.
 */
const noise = (x: number, y: number, salt = 0): number => {
  const h = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263) ^ Math.imul(salt + 1, 2147483647);
  return ((h ^ (h >>> 13)) >>> 0) % 256;
};

interface Scene { px: Uint8Array; width: number; height: number }

function scene(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number],
): Scene {
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * width + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  }
  return { px, width, height };
}

const BG: [number, number, number] = [236, 238, 240];   // a plain wall
const FG: [number, number, number] = [40, 70, 190];     // the subject

/** A disc of `FG` on a plain `BG` ground — the easy, common case. */
const disc = (size = 128, radius = size * 0.3) => scene(size, size, (x, y) =>
  Math.hypot(x - size / 2, y - size / 2) < radius ? FG : BG);

const at = (m: { alpha: Uint8Array }, width: number, x: number, y: number) => m.alpha[y * width + x];

describe('liftSubject (matte/border@1)', () => {
  it('cuts a subject off a plain ground, with the numbers to back it', () => {
    const { px, width, height } = disc();
    const matte = liftSubject(px, width, height);

    expect(at(matte, width, 64, 64)).toBe(255);   // centre: subject
    expect(at(matte, width, 2, 2)).toBe(0);       // corner: background
    // pi * 0.3^2 = 0.283 of the canvas.
    expect(matte.coverage).toBeGreaterThan(0.26);
    expect(matte.coverage).toBeLessThan(0.30);
    expect(matte.components).toBe(1);
    expect(matte.backgroundUniformity).toBe(1);
    expect(matte.confidence).toBeGreaterThan(0.9);
    expect(matte.version).toBe(MATTE_VERSION);
  });

  it('is deterministic — same pixels, same mask, same confidence', () => {
    const { px, width, height } = disc();
    const a = liftSubject(px, width, height);
    const b = liftSubject(px, width, height);
    expect(Buffer.from(b.alpha)).toEqual(Buffer.from(a.alpha));
    expect(b.confidence).toBe(a.confidence);
    expect(b.coverage).toBe(a.coverage);
  });

  it('keeps a real hole open, fills a small one, and never sees a single-pixel speck', () => {
    // A ring: the middle is background the edge flood cannot reach, and it is
    // large, so it must stay a hole. Inside the wall sit two specks of
    // background — a 3x3 that survives smoothing and is filled as noise, and a
    // lone pixel that the smoothing pass removes before anything classifies
    // it. Both end up subject; only one was ever a "hole".
    const size = 160, cx = 80, cy = 80;
    const { px, width, height } = scene(size, size, (x, y) => {
      const r = Math.hypot(x - cx, y - cy);
      if (Math.abs(x - 115) <= 1 && Math.abs(y - 80) <= 1) return BG;  // 3x3 speck
      if (x === 45 && y === 80) return BG;                             // lone pixel
      return r < 55 && r > 22 ? FG : BG;
    });
    const matte = liftSubject(px, width, height);

    expect(at(matte, width, cx, cy)).toBe(0);           // the ring's eye stays open
    expect(at(matte, width, 115, 80)).toBe(255);        // 3x3 speck filled as noise
    expect(at(matte, width, 45, 80)).toBe(255);         // lone pixel smoothed away
    expect(matte.holes).toBe(1);
    expect(matte.filledHoles).toBe(1);
  });

  it('reads a cast shadow as the ground it falls on, not as part of the subject', () => {
    // The failure that sends people back to Photoshop: a shadow is the ground's
    // own colour with the light taken away, it touches the object, and an
    // RGB-distance flood therefore welds it on as a dark skirt.
    const size = 160;
    const shadowed = scene(size, size, (x, y) => {
      if (Math.hypot(x - 70, y - 70) < 34) return FG;
      // An ellipse of shadow, overlapping the disc and running off to the SE.
      const sx = (x - 95) / 46, sy = (y - 95) / 26;
      if (sx * sx + sy * sy < 1) return BG.map((c) => Math.round(c * 0.62)) as [number, number, number];
      return BG;
    });

    const lifted = liftSubject(shadowed.px, shadowed.width, shadowed.height);
    expect(at(lifted, shadowed.width, 70, 70)).toBe(255);    // the object
    expect(at(lifted, shadowed.width, 125, 100)).toBe(0);    // its shadow, not the object

    // Turning the rule off reproduces the old behaviour, which is the proof
    // that the rule is what fixed it rather than some other change.
    const naive = liftSubject(shadowed.px, shadowed.width, shadowed.height, { shadowTolerance: 0 });
    expect(at(naive, shadowed.width, 125, 100)).toBe(255);
    expect(lifted.coverage).toBeLessThan(naive.coverage);
  });

  it('keeps a neutral object that is merely darker than a neutral ground', () => {
    // The shadow arm's one catastrophic failure: a grey object on a light grey
    // desk is chromatically identical to a shadow of that desk, so matching on
    // chromaticity alone eats the whole subject. Nothing local separates them,
    // so the outcome decides — the strict cut is kept when the shadow-aware
    // one leaves nothing behind.
    const size = 160;
    const { px, width, height } = scene(size, size, (x, y) =>
      (Math.hypot(x - 80, y - 80) < 55 ? [172, 178, 170] : [205, 205, 203]));
    const matte = liftSubject(px, width, height);

    expect(at(matte, width, 80, 80)).toBe(255);
    expect(matte.coverage).toBeGreaterThan(0.3);
    expect(matte.notes.join(' ')).toContain('strict cut was used');
  });

  it('never absorbs a subject that is merely brighter than the ground', () => {
    // The shadow rule is one-sided on purpose: darker-and-same-hue is a
    // shadow, brighter-and-same-hue is a white mug on a grey desk.
    const size = 128;
    const grey: [number, number, number] = [150, 152, 155];
    const { px, width, height } = scene(size, size, (x, y) =>
      (Math.hypot(x - 64, y - 64) < 34 ? [246, 248, 250] : grey));
    const matte = liftSubject(px, width, height);

    expect(at(matte, width, 64, 64)).toBe(255);
    expect(matte.coverage).toBeGreaterThan(0.15);
  });

  it('does not eat a subject that runs off the frame', () => {
    // A cropped object touches the edge, so its own pixels sit in the seed
    // ring. Seeding only from edge pixels that match the background is what
    // keeps the flood from starting *inside* the subject and hollowing it.
    const size = 128;
    const { px, width, height } = scene(size, size, (x, y) => (x > 70 && y > 40 && y < 100 ? FG : BG));
    const matte = liftSubject(px, width, height);

    expect(at(matte, width, 127, 70)).toBe(255);        // still subject at the edge
    expect(at(matte, width, 10, 10)).toBe(0);
    expect(matte.coverage).toBeGreaterThan(0.2);
    expect(matte.confidence).toBeGreaterThan(0.8);
  });

  it('drops debris but keeps genuinely separate pieces', () => {
    const size = 160;
    const { px, width, height } = scene(size, size, (x, y) => {
      if (Math.hypot(x - 50, y - 80) < 34) return FG;   // main piece
      if (Math.hypot(x - 115, y - 80) < 20) return FG;  // a real second piece
      if (Math.hypot(x - 140, y - 20) < 2) return FG;   // a crumb
      return BG;
    });
    const matte = liftSubject(px, width, height);

    expect(matte.components).toBe(2);
    expect(matte.droppedComponents).toBe(1);
    expect(at(matte, width, 115, 80)).toBe(255);
    expect(at(matte, width, 140, 20)).toBe(0);
    expect(matte.notes.join(' ')).toContain('debris');
  });

  it('separates a subject from a gently shaded ground, with less certainty', () => {
    // A vignette: the ground is not one colour any more, so several edge
    // buckets are needed and uniformity drops — the cut still lands, and the
    // confidence says it was a harder call.
    const size = 128;
    const { px, width, height } = scene(size, size, (x, y) => {
      if (Math.hypot(x - 64, y - 64) < 34) return FG;
      const shade = 236 - Math.round((x + y) / 8);
      return [shade, shade + 2, shade + 4];
    });
    const flat = liftSubject(disc().px, 128, 128);
    const shaded = liftSubject(px, width, height);

    expect(at(shaded, width, 64, 64)).toBe(255);
    expect(shaded.confidence).toBeGreaterThan(0.4);
    expect(shaded.confidence).toBeLessThan(flat.confidence);
  });

  it('refuses to invent a subject in a textured scene', () => {
    const size = 128;
    const { px, width, height } = scene(size, size, (x, y) =>
      [noise(x, y, 1), noise(x, y, 2), noise(x, y, 3)]);
    const matte = liftSubject(px, width, height);

    expect(matte.confidence).toBeLessThan(0.4);
    expect(matte.notes.length).toBeGreaterThan(0);
  });
});

describe('tuneMatte', () => {
  it('picks a tolerance that beats both ends of the ladder', () => {
    // A subject close to its ground: too tight leaves background attached,
    // too loose eats the object, and the useful value is somewhere between.
    const size = 160;
    const { px, width, height } = scene(size, size, (x, y) =>
      (Math.hypot(x - 80, y - 80) < 50 ? [150, 158, 146] : [196, 198, 190]));

    const tuned = tuneMatte(px, width, height);
    expect(tuned.candidates).toHaveLength(8);
    expect(tuned.matte.confidence).toBe(Math.max(...tuned.candidates.map((c) => c.confidence)));
    // The winner is a real cut, not a degenerate one at either extreme.
    expect(tuned.matte.coverage).toBeGreaterThan(0.15);
    expect(tuned.matte.coverage).toBeLessThan(0.8);
    expect(at(tuned.matte, width, 80, 80)).toBe(255);
  });

  it('beats the fixed default on an image the default handles badly', () => {
    const size = 160;
    const { px, width, height } = scene(size, size, (x, y) =>
      (Math.hypot(x - 80, y - 80) < 50 ? [150, 158, 146] : [196, 198, 190]));
    const fixed = liftSubject(px, width, height);            // tolerance 34
    const tuned = tuneMatte(px, width, height);
    expect(tuned.matte.confidence).toBeGreaterThanOrEqual(fixed.confidence);
  });

  it('is deterministic, and ties go to the lower tolerance', () => {
    const { px, width, height } = disc();
    const a = tuneMatte(px, width, height);
    const b = tuneMatte(px, width, height);
    expect(b.tolerance).toBe(a.tolerance);
    expect(Buffer.from(b.matte.alpha)).toEqual(Buffer.from(a.matte.alpha));
    // On a flat ground every rung cuts identically, so the first one wins.
    const best = Math.max(...a.candidates.map((c) => c.confidence));
    const firstBest = a.candidates.find((c) => c.confidence === best)!;
    expect(a.tolerance).toBe(firstBest.tolerance);
  });
});

describe('extrudeFromRgba with matte: auto', () => {
  /** A subject and a ground that are both mid-toned: luma cannot split these. */
  const colouredGround = () => scene(128, 128, (x, y) =>
    (Math.hypot(x - 64, y - 64) < 40 ? [200, 60, 60] : [60, 120, 90]));

  it('forges a photo-style image that luma alone would refuse', async () => {
    const { px, width, height } = colouredGround();

    await expect(extrudeFromRgba(px.slice(), width, height, { texture: false }))
      .rejects.toThrow(/fills the whole canvas/);

    const { stats } = await extrudeFromRgba(px.slice(), width, height, {
      matte: 'auto', texture: false,
    });
    expect(stats.mode).toBe('matte');
    expect(stats.triangles).toBeGreaterThan(0);
    expect(stats.outerLoops).toBe(1);
    expect(stats.matte?.confidence).toBeGreaterThan(0.4);
    expect(stats.matte?.version).toBe(MATTE_VERSION);
  });

  it('reports the refusal with its numbers when nothing separates', async () => {
    const { px, width, height } = scene(128, 128, (x, y) =>
      [noise(x, y, 4), noise(x, y, 5), noise(x, y, 6)]);
    await expect(extrudeFromRgba(px, width, height, { matte: 'auto', texture: false }))
      .rejects.toThrow(/Could not lift a subject.*confidence \d+%/s);
  });

  it('leaves artwork that has its own alpha alone', async () => {
    // Transparency is the image telling us what it means; the matte must not
    // second-guess it, or a logo with a deliberate cut-out gets re-cut.
    const size = 96;
    const px = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const solid = Math.hypot(x - 48, y - 48) < 30;
      px[i] = 240; px[i + 1] = 60; px[i + 2] = 90; px[i + 3] = solid ? 255 : 0;
    }
    const { stats } = await extrudeFromRgba(px, size, size, { matte: 'auto', texture: false });
    expect(stats.mode).toBe('alpha');
    expect(stats.matte).toBeUndefined();
  });

  it('produces identical geometry on repeat runs', async () => {
    const a = await extrudeFromRgba(colouredGround().px, 128, 128, { matte: 'auto', texture: false });
    const b = await extrudeFromRgba(colouredGround().px, 128, 128, { matte: 'auto', texture: false });
    expect(b.stats.triangles).toBe(a.stats.triangles);
    expect(b.stats.vertices).toBe(a.stats.vertices);
    expect(b.stats.matte?.coverage).toBe(a.stats.matte?.coverage);
  });
});
