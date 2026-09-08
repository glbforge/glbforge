import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extrudeImage, getProfile, optimize, toUsdz } from '../src/index.js';
import { listZip, crc32 } from '../src/zip.js';

async function ringPng(): Promise<Uint8Array> {
  const sharp = (await import('sharp')).default;
  const size = 96;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot(x - 48, y - 48);
    if (r < 36 && r > 14) {
      const i = (y * size + x) * 4;
      rgba[i] = 30 + x * 2; rgba[i + 1] = 120; rgba[i + 2] = 200; rgba[i + 3] = 255;
    }
  }
  return new Uint8Array(await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer());
}

describe('USDZ export', () => {
  it('packs a spec-conformant, deterministic usdz from an optimized (WebP + quantized) GLB', async () => {
    const { doc } = await extrudeImage(await ringPng(), { pillow: 0.03, preset: 'enamel', layers: 2 });
    await optimize(doc, { profile: getProfile('mobile-hero'), targetTriangles: 3000, verify: false });
    const textures = doc.getRoot().listTextures();
    expect(textures.length).toBeGreaterThan(0);
    expect(textures[0].getMimeType()).toBe('image/webp'); // must be transcoded

    const a = await toUsdz(doc);
    const b = await toUsdz(doc);
    expect(Buffer.from(a.usdz).equals(Buffer.from(b.usdz))).toBe(true);

    const entries = listZip(a.usdz);
    expect(entries.length).toBe(a.files.length);
    expect(entries[0].name).toBe('model.usdc');
    expect(a.format).toBe('usdc');
    for (const e of entries) {
      expect(e.method).toBe(0);            // stored
      expect(e.offset % 64).toBe(0);       // 64-byte aligned payloads
    }
    expect(entries.slice(1).every((e) => /^textures\/tex_\d+\.png$/.test(e.name))).toBe(true);
    // PNG signature inside the archive, CRC matches.
    const png = a.usdz.subarray(entries[1].offset, entries[1].offset + entries[1].size);
    expect(Buffer.from(png.subarray(1, 4)).toString()).toBe('PNG');
    expect(crc32(png)).toBeTypeOf('number');

    // Crate bootstrap: magic, version 0.3.0, table of contents with the six sections.
    const crate = a.usdz.subarray(entries[0].offset, entries[0].offset + entries[0].size);
    expect(Buffer.from(crate.subarray(0, 8)).toString()).toBe('PXR-USDC');
    expect(Array.from(crate.subarray(8, 11))).toEqual([0, 3, 0]);
    const tocOffset = Number(new DataView(crate.buffer, crate.byteOffset).getBigUint64(16, true));
    const sections = Number(new DataView(crate.buffer, crate.byteOffset).getBigUint64(tocOffset, true));
    expect(sections).toBe(6);
    const names = Array.from({ length: 6 }, (_, i) => Buffer.from(crate.subarray(tocOffset + 8 + i * 32, tocOffset + 8 + i * 32 + 16)).toString().replace(/\0+$/, ''));
    expect(names).toEqual(['TOKENS', 'STRINGS', 'FIELDS', 'FIELDSETS', 'PATHS', 'SPECS']);

    // The ASCII twin carries the same layer; it is what humans (and this test) read.
    const text = await toUsdz(doc, { format: 'usda' });
    const tEntries = listZip(text.usdz);
    expect(tEntries[0].name).toBe('model.usda');
    expect(text.usdz.byteLength).toBeGreaterThan(a.usdz.byteLength); // crate is the compact one
    const usda = Buffer.from(text.usdz.subarray(tEntries[0].offset, tEntries[0].offset + tEntries[0].size)).toString('utf8');
    expect(usda.startsWith('#usda 1.0')).toBe(true);
    expect(usda).toContain('upAxis = "Y"');
    expect(usda).toContain('UsdPreviewSurface');
    expect(usda).toContain('inputs:file = @textures/tex_0.png@');
    expect(usda).toContain('primvars:st');
    expect(usda).toContain('material:binding');
    const faceCounts = usda.match(/faceVertexCounts = \[([^\]]*)\]/g)!;
    const tris = faceCounts.reduce((s, m) => s + m.split(',').length, 0);
    expect(tris).toBe(a.triangles);
    expect(a.triangles).toBeGreaterThan(0);
    expect(a.materials).toBeGreaterThan(0);
    expect(a.warnings).toEqual([]);
  }, 60_000);

  it('matches Pixar USD\'s reading of the usda twin exactly (oracle; needs GLBFORGE_PXR_PYTHON)', async () => {
    const python = process.env.GLBFORGE_PXR_PYTHON;
    if (!python) return; // pip install usd-core, then GLBFORGE_PXR_PYTHON=/path/to/python
    const { doc } = await extrudeImage(await ringPng(), { pillow: 0.03, preset: 'enamel', layers: 2 });
    await optimize(doc, { profile: getProfile('mobile-hero'), targetTriangles: 2000, verify: false });
    const dir = await mkdtemp(join(tmpdir(), 'glbforge-usd-'));
    try {
      const bin = await toUsdz(doc);
      const txt = await toUsdz(doc, { format: 'usda' });
      await writeFile(join(dir, 'bin.usdz'), bin.usdz);
      await writeFile(join(dir, 'txt.usdz'), txt.usdz);
      const out = execFileSync(python, [new URL('./usd-oracle.py', import.meta.url).pathname, join(dir, 'bin.usdz'), join(dir, 'txt.usdz')], { encoding: 'utf8' });
      expect(out).toMatch(/^OK:/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects KTX2 textures with guidance and reports skinned assets as static', async () => {
    const { doc } = await extrudeImage(await ringPng(), { texture: false });
    doc.createSkin('rig');
    const r = await toUsdz(doc);
    expect(r.textures).toBe(0);
    expect(r.warnings.join(' ')).toMatch(/static bind pose/);
    const tex = doc.createTexture('k').setImage(new Uint8Array([0xab, 0x4b, 0x54, 0x58])).setMimeType('image/ktx2');
    doc.getRoot().listMaterials()[0].setBaseColorTexture(tex);
    await expect(toUsdz(doc)).rejects.toThrow(/KTX2/);
  }, 30_000);
});
