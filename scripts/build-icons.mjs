// Rasterise the favicon set from site/favicon.svg.
//
// Deterministic by construction: one vector source, fixed sizes, fixed
// background. Re-running must produce identical bytes, so the generated
// files can be committed and diffed like any other output.
//
//   node scripts/build-icons.mjs
//
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const site = join(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const svg = readFileSync(join(site, 'favicon.svg'));

// The page background. Transparency is right for a browser tab, but iOS and
// Android composite home-screen icons over an unknown colour, so those get an
// opaque plate instead of whatever the OS would pick.
const PLATE = { r: 0x0b, g: 0x0d, b: 0x14, alpha: 1 };

/** The bare mark, transparent, at `px` square. */
const mark = (px) =>
  sharp(svg, { density: Math.ceil((72 * px) / 64) })
    .resize(px, px, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();

/**
 * The mark centred on an opaque plate. `inset` keeps the cube inside the 80%
 * safe circle a maskable icon may be cropped to.
 */
async function plated(px, inset = 0.68) {
  const inner = Math.round(px * inset);
  const offset = Math.round((px - inner) / 2);
  return sharp({ create: { width: px, height: px, channels: 4, background: PLATE } })
    .composite([{ input: await mark(inner), left: offset, top: offset }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Pack PNGs into an .ico container (PNG-in-ICO; Vista and newer). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size === 256 ? 0 : size, 0); // width  (0 means 256)
    e.writeUInt8(size === 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette size
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const out = (name, data) => {
  writeFileSync(join(site, name), data);
  console.log(`  ${name}  ${data.length.toLocaleString()} bytes`);
};

const icoSizes = [16, 32, 48];
out('favicon.ico', ico(await Promise.all(
  icoSizes.map(async (size) => ({ size, data: await mark(size) })),
)));
out('apple-touch-icon.png', await plated(180));
out('icon-192.png', await plated(192));
out('icon-512.png', await plated(512));
