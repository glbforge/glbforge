import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Document } from '@gltf-transform/core';
import { KHRTextureBasisu } from '@gltf-transform/extensions';
import { listTextureSlots } from '@gltf-transform/functions';
import sharp from 'sharp';

const run = promisify(execFile);

export type Ktx2Encoder = 'basisu' | 'toktx';

/**
 * Find an available KTX2 encoder CLI. `basisu` (Binomial, `brew install
 * basis_universal`) is preferred; `toktx` (KTX-Software) also works.
 */
export async function detectKtx2Encoder(): Promise<Ktx2Encoder | null> {
  for (const [bin, args] of [['basisu', ['-version']], ['toktx', ['--version']]] as const) {
    try {
      await run(bin, [...args]);
      return bin as Ktx2Encoder;
    } catch {
      /* not installed — try next */
    }
  }
  return null;
}

const SRGB_SLOTS = /baseColor|emissive/i;
const NORMAL_SLOTS = /normal/i;

/**
 * Re-encode every texture as KTX2 (GPU-resident compression, ~8x less video
 * memory than WebP/PNG which upload as raw RGBA). Color maps use ETC1S
 * (smallest); normal maps use UASTC (higher quality — ETC1S artifacts read
 * as shading noise on normals). Marks KHR_texture_basisu as required.
 */
export async function ktx2Compress(
  doc: Document,
  opts: { maxSize: number; encoder?: Ktx2Encoder; log?: (msg: string) => void },
): Promise<number> {
  const encoder = opts.encoder ?? (await detectKtx2Encoder());
  if (!encoder) {
    throw new Error(
      'No KTX2 encoder found. Install one: `brew install basis_universal` ' +
      '(preferred) or KTX-Software for `toktx`.',
    );
  }

  const textures = doc.getRoot().listTextures()
    .filter((t) => t.getMimeType() !== 'image/ktx2' && t.getImage());
  if (textures.length === 0) return 0;

  const workDir = await mkdtemp(join(tmpdir(), 'xui-ktx2-'));
  try {
    for (const [i, texture] of textures.entries()) {
      const slots = listTextureSlots(texture);
      const isNormal = slots.some((s) => NORMAL_SLOTS.test(s));
      const isSrgb = !isNormal && slots.some((s) => SRGB_SLOTS.test(s));

      // Decode + resize with sharp; snap dimensions to multiples of 4 for
      // clean block compression.
      const image = sharp(Buffer.from(texture.getImage()!));
      const meta = await image.metadata();
      const scale = Math.min(1, opts.maxSize / Math.max(meta.width ?? 1, meta.height ?? 1));
      const width = Math.max(4, Math.floor(((meta.width ?? 4) * scale) / 4) * 4);
      const height = Math.max(4, Math.floor(((meta.height ?? 4) * scale) / 4) * 4);
      const pngPath = join(workDir, `t${i}.png`);
      const ktxPath = join(workDir, `t${i}.ktx2`);
      await writeFile(pngPath, await image.resize(width, height, { fit: 'fill' }).png().toBuffer());

      const args =
        encoder === 'basisu'
          ? [
              pngPath, '-output_file', ktxPath, '-mipmap',
              ...(isNormal
                ? ['-uastc', '-uastc_level', '2', '-uastc_rdo_l', '0.5']
                : ['-q', '160']),
              ...(isSrgb ? [] : ['-linear']),
            ]
          : [
              '--genmipmap',
              '--encode', isNormal ? 'uastc' : 'etc1s',
              ...(isNormal ? ['--uastc_quality', '2', '--zcmp', '18'] : ['--qlevel', '160']),
              '--assign_oetf', isSrgb ? 'srgb' : 'linear',
              ktxPath, pngPath,
            ];
      await run(encoder, args);

      const ktxBytes = await readFile(ktxPath);
      texture.setImage(new Uint8Array(ktxBytes)).setMimeType('image/ktx2');
      opts.log?.(
        `ktx2 (${isNormal ? 'uastc' : 'etc1s'}): ${texture.getName() || 't' + i} ` +
        `${width}x${height} -> ${(ktxBytes.byteLength / 1024).toFixed(0)}KB`,
      );
    }
    doc.createExtension(KHRTextureBasisu).setRequired(true);
    return textures.length;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
