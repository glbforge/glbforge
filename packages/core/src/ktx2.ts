import { Document } from '@gltf-transform/core';
import { KHRTextureBasisu } from '@gltf-transform/extensions';
import { listTextureSlots } from '@gltf-transform/functions';

// Node-only dependencies load lazily so this module can sit in a browser
// bundle unexecuted (KTX2 encoding requires local CLIs regardless).
async function nodeDeps() {
  const [{ execFile }, { promisify }, fs, os, path, sharp] = await Promise.all([
    import('node:child_process'), import('node:util'), import('node:fs/promises'),
    import('node:os'), import('node:path'), import('sharp'),
  ]);
  return { run: promisify(execFile), fs, os, path, sharp: sharp.default };
}

export type Ktx2Encoder = 'basisu' | 'toktx';

/**
 * Find an available KTX2 encoder CLI. `basisu` (Binomial, `brew install
 * basis_universal`) is preferred; `toktx` (KTX-Software) also works.
 */
export async function detectKtx2Encoder(): Promise<Ktx2Encoder | null> {
  const { run } = await nodeDeps();
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
 * Re-encode every texture as KTX2 (GPU-resident compression, ~4-8x less video
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

  // `ImageUtils` only knows how to read `image/ktx2` dimensions/VRAM after
  // this runs — normally a side effect of `NodeIO`/`WebIO` reading a file
  // that declares the extension. A Document built up in memory and never
  // round-tripped through either (every caller here: analyze() straight
  // after this function) never triggers that, and analyze() would silently
  // report the texture as undecodable — width null, 0 VRAM — right after
  // this function successfully wrote it.
  KHRTextureBasisu.register();

  const textures = doc.getRoot().listTextures()
    .filter((t) => t.getMimeType() !== 'image/ktx2' && t.getImage());
  if (textures.length === 0) return 0;

  const { run, fs, os, path, sharp } = await nodeDeps();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glbforge-ktx2-'));
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
      const pngPath = path.join(workDir, `t${i}.png`);
      const ktxPath = path.join(workDir, `t${i}.ktx2`);
      await fs.writeFile(pngPath, await image.resize(width, height, { fit: 'fill' }).png().toBuffer());

      // basisu writes its native .basis container by default — `-ktx2` is
      // required to get an actual KTX2 file; without it, the bytes here
      // fail the KTX2 identifier check every real loader (three.js
      // KTX2Loader, Babylon, model-viewer) makes before transcoding, despite
      // the `.ktx2` filename, the `image/ktx2` mimeType set below, and
      // KHR_texture_basisu being marked required.
      const args =
        encoder === 'basisu'
          ? [
              pngPath, '-output_file', ktxPath, '-ktx2', '-mipmap',
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

      const ktxBytes = await fs.readFile(ktxPath);
      texture.setImage(new Uint8Array(ktxBytes)).setMimeType('image/ktx2');
      opts.log?.(
        `ktx2 (${isNormal ? 'uastc' : 'etc1s'}): ${texture.getName() || 't' + i} ` +
        `${width}x${height} -> ${(ktxBytes.byteLength / 1024).toFixed(0)}KB`,
      );
    }
    doc.createExtension(KHRTextureBasisu).setRequired(true);
    return textures.length;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
