// Build the social card (og:image) at site/og.png.
//
// The card renders its own subject with the project's rasterizer — the same
// deterministic software render the pipeline gates on — so the picture people
// see when the link is shared is a real 150k-triangle asset the site serves,
// not a mockup.
//
// One caveat on reproducibility: the text is laid out by the system's font
// stack, so the committed PNG is the artifact of record. Re-running on a
// machine with different fonts can shift the type by a hair.
//
//   pnpm build:og
//
import sharp from 'sharp';
import { createNodeIO, renderViews } from '../packages/core/dist/index.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'site');

const W = 1200, H = 630;
const BG = '#0b0d14', PANEL = '#141826', LINE = '#272c41';
const TEXT = '#e8eaf0', DIM = '#8d93ab', ACCENT = '#7c5cff', ACCENT2 = '#63b3ff';
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'SF Mono', Menlo, monospace";

// The asset the landing page already shows off, from the angle the hero uses.
const io = await createNodeIO();
const doc = await io.read(join(site, 'models', 'cat.glb'));
const [view] = await renderViews(doc, {
  size: 720,
  cameras: [{ name: 'og', position: [0.62, 0.30, 0.74], fovDeg: 32 }],
});

// The rasterizer paints an opaque ground. Knock it out so the subject sits on
// the card's own gradient instead of a black square, feathering the near-black
// band so the silhouette keeps its antialiasing.
const { data, info } = await sharp(Buffer.from(view.png))
  .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
for (let i = 0; i < data.length; i += 4) {
  const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
  if (lum < 26) data[i + 3] = 0;
  else if (lum < 52) data[i + 3] = Math.round(((lum - 26) / 26) * 255);
}
const subject = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
  .resize(508, 508).png().toBuffer();

/** The cube mark, same geometry as site/favicon.svg. */
const mark = (x, y, s) => `
  <g transform="translate(${x},${y}) scale(${s / 64})">
    <polygon points="32,5 55,18.5 32,32 9,18.5" fill="${ACCENT2}"/>
    <polygon points="55,18.5 55,45.5 32,59 32,32" fill="${ACCENT}"/>
    <polygon points="9,18.5 32,32 32,59 9,45.5" fill="#4b31b0"/>
  </g>`;

const card = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <radialGradient id="glow" cx="50%" cy="42%" r="62%">
      <stop offset="0%" stop-color="#1b2136"/><stop offset="100%" stop-color="${BG}"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <ellipse cx="906" cy="315" rx="330" ry="300" fill="url(#glow)"/>
  ${mark(72, 62, 42)}
  <text x="126" y="94" font-family="${FONT}" font-size="34" font-weight="700" fill="${TEXT}">GLBForge</text>

  <text x="72" y="248" font-family="${FONT}" font-size="52" font-weight="700" fill="${TEXT}">AI generates 3D models.</text>
  <text x="72" y="312" font-family="${FONT}" font-size="52" font-weight="700" fill="${ACCENT}">GLBForge ships them.</text>

  <text x="72" y="372" font-family="${FONT}" font-size="21" fill="${DIM}">Inspect, diff, and optimize against a versioned budget.</text>

  <rect x="72" y="410" width="474" height="56" rx="10" fill="${PANEL}" stroke="${LINE}"/>
  <text x="94" y="446" font-family="${MONO}" font-size="20" fill="${DIM}">$</text>
  <text x="116" y="446" font-family="${MONO}" font-size="20" fill="${TEXT}">npx glbforge ship model.glb</text>

  <rect x="72" y="506" width="250" height="40" rx="8" fill="none" stroke="${LINE}"/>
  <text x="90" y="532" font-family="${FONT}" font-size="18" font-weight="700" fill="${ACCENT2}">−94%</text>
  <text x="152" y="532" font-family="${FONT}" font-size="16" fill="${DIM}">89MB → 5.5MB, in 7s</text>
</svg>`;

const out = join(site, 'og.png');
await sharp({ create: { width: W, height: H, channels: 4, background: { r: 11, g: 13, b: 20, alpha: 1 } } })
  .composite([{ input: Buffer.from(card) }, { input: subject, left: 652, top: 61 }])
  .png({ compressionLevel: 9 })
  .toFile(out);
console.log(`  og.png  ${W}x${H}`);
