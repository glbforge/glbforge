/**
 * Deterministic software renderer: renders a document from a rig of known
 * cameras — no GPU, no browser. Z-buffered rasterizer with barycentric UV
 * texture sampling and a fixed directional light; identical input yields
 * identical pixels. Used for training-pair generation (`glbforge dataset`),
 * perceptual verification of optimization (SSIM before/after), and agent
 * previews (MCP thumbnails).
 *
 * Colour spaces, since glTF uses two of them for one quantity: shading runs
 * in LINEAR light and the output buffer is sRGB-encoded, like any viewer.
 * `baseColorFactor` is already linear; base-color texels are sRGB bytes and
 * are decoded on sample. Getting this wrong is not a cosmetic bug — it makes
 * a surface that moves between the texture slot and the factor slot (which
 * is exactly what `prune()` does to a solid texture) score as a visible
 * change when nothing visible changed. Data textures (normal, ORM) would be
 * linear already; only base color is ever decoded here.
 *
 * Texture sampling is nearest-neighbour with no mip pyramid: see
 * `sampleTexel` for why that is deliberate and what it costs.
 */
import { Document, Node, Primitive, Texture } from '@gltf-transform/core';
import { readFloat } from '../accessors.js';
import { computeSmoothNormals } from '../normals.js';
import { SRGB8_TO_LINEAR, linearToSrgb8 } from '../color.js';

export interface RenderCamera {
  name: string;
  /** Unit-sphere position, scaled by the framing distance at render time — or the absolute eye when `absolute` is set. */
  position: [number, number, number];
  fovDeg: number;
  /** Absolute camera: `position` is the eye in world space and `target` the look-at point (no auto framing). */
  absolute?: boolean;
  target?: [number, number, number];
}

export interface RenderedView {
  name: string;
  png: Uint8Array;
  camera: { position: [number, number, number]; target: [number, number, number]; fovDeg: number };
}

/** A view as raw pixels — what the comparators consume (no encoder involved). */
export interface RawView {
  name: string;
  /** RGBA, size*size*4. */
  rgba: Uint8Array;
  /** 1 where geometry was drawn, 0 for background. */
  mask: Uint8Array;
  size: number;
  camera: { position: [number, number, number]; target: [number, number, number]; fovDeg: number };
}

/** Bounding frame shared across renders so cameras don't move between them. */
export interface RenderFrame {
  center: [number, number, number];
  radius: number;
}

export interface DecodedTexture { rgba: Uint8Array; width: number; height: number }

/**
 * Environment-specific image decoder (encoded bytes -> RGBA). Node's default
 * uses sharp; browsers supply a canvas-based decoder. Return null for
 * formats the environment cannot decode (e.g. KTX2).
 */
export type TextureDecoder = (bytes: Uint8Array, mimeType: string) => Promise<DecodedTexture | null>;

export interface RenderOptions {
  /** Output edge length in pixels. Default 512. */
  size?: number;
  cameras?: RenderCamera[];
  /** Override the auto-computed framing (use `computeFrame` on a reference doc). */
  frame?: RenderFrame;
  /** Base-color texture decoder. Omit to render base-color factors only. */
  textureDecoder?: TextureDecoder;
  /** Supersampling factor: rasterize at size*n and box-filter down. Removes
   *  the per-pixel aliasing noise of dense meshes so comparisons measure
   *  shape and shading, not sampling luck. Default 1. */
  supersample?: number;
}

/** 10-view rig: 8 orbit azimuths at two elevations + top + front-low. */
export function defaultRig(): RenderCamera[] {
  const cameras: RenderCamera[] = [];
  for (let i = 0; i < 8; i++) {
    const azimuth = (i / 8) * Math.PI * 2;
    const elevation = i % 2 === 0 ? 0.35 : 0.12;
    cameras.push({
      name: `orbit_${i}`,
      position: [
        Math.cos(azimuth) * Math.cos(elevation),
        Math.sin(elevation),
        Math.sin(azimuth) * Math.cos(elevation),
      ],
      fovDeg: 40,
    });
  }
  cameras.push({ name: 'top', position: [0.01, 0.999, 0.01], fovDeg: 40 });
  cameras.push({ name: 'front_low', position: [0, -0.15, 0.99], fovDeg: 40 });
  return cameras;
}

/**
 * 4-view verification rig: three-quarter views every 90° at a moderate
 * elevation, so every side of the asset is scored once. Fixed forever —
 * changing it changes every SSIM number ever reported.
 */
export function verifyRig(): RenderCamera[] {
  const elevation = 0.3;
  return [45, 135, 225, 315].map((deg) => {
    const azimuth = (deg * Math.PI) / 180;
    return {
      name: `verify_${deg}`,
      position: [
        Math.cos(azimuth) * Math.cos(elevation),
        Math.sin(elevation),
        Math.sin(azimuth) * Math.cos(elevation),
      ] as [number, number, number],
      fovDeg: 40,
    };
  });
}

/** Single three-quarter hero view (thumbnails). */
export function thumbnailRig(): RenderCamera[] {
  return [{ name: 'thumbnail', position: [0.62, 0.32, 0.72], fovDeg: 35 }];
}

/** Node's default decoder (sharp, lazily imported so browsers never touch it). */
export function sharpTextureDecoder(maxSize = 512): TextureDecoder {
  return async (bytes) => {
    try {
      const sharp = (await import('sharp')).default;
      const raw = await sharp(Buffer.from(bytes))
        .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { rgba: new Uint8Array(raw.data), width: raw.info.width, height: raw.info.height };
    } catch {
      return null;
    }
  };
}

export interface Fragment {
  tris: Float32Array;     // world xyz * 9 per tri
  normals: Float32Array;  // world-space vertex normals * 9 per tri
  uvs: Float32Array;      // uv * 6 per tri
  texture: DecodedTexture | null;
  color: [number, number, number]; // linear base color factor
}

async function gatherFragments(doc: Document, decoder: TextureDecoder | undefined): Promise<Fragment[]> {
  // Decode each texture once.
  const decoded = new Map<Texture, DecodedTexture | null>();
  const decode = async (texture: Texture | null) => {
    if (!texture || !decoder) return null;
    if (decoded.has(texture)) return decoded.get(texture)!;
    const image = texture.getImage();
    const entry = image ? await decoder(image, texture.getMimeType()) : null;
    decoded.set(texture, entry);
    return entry;
  };

  const fragments: Fragment[] = [];
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (!scene) return fragments;
  const visitQueue: Node[] = [...scene.listChildren()];
  while (visitQueue.length) {
    const node = visitQueue.pop()!;
    visitQueue.push(...node.listChildren());
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = [...node.getWorldMatrix()];
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== Primitive.Mode.TRIANGLES) continue;
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const p = readFloat(pos);
      const uvAcc = prim.getAttribute('TEXCOORD_0');
      const uv = uvAcc ? readFloat(uvAcc) : null;
      const idx = prim.getIndices()?.getArray() ?? null;
      const count = idx ? idx.length : pos.getCount();
      // Vertex normals as a viewer would see them: the NORMAL attribute, or
      // smooth normals computed on load when the asset ships without any.
      const nrmAcc = prim.getAttribute('NORMAL');
      const nrm = nrmAcc ? readFloat(nrmAcc) : computeSmoothNormals(prim);
      // Normal matrix = inverse-transpose of the upper 3x3; uniform scale is
      // the common case, so normalizing after the plain 3x3 is enough here.
      const tris = new Float32Array(count * 3);
      const normals = new Float32Array(count * 3);
      const uvs = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) {
        const v = idx ? idx[i] : i;
        const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
        tris[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
        tris[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        tris[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        if (nrm) {
          const nx = nrm[v * 3], ny = nrm[v * 3 + 1], nz = nrm[v * 3 + 2];
          let wx = m[0] * nx + m[4] * ny + m[8] * nz;
          let wy = m[1] * nx + m[5] * ny + m[9] * nz;
          let wz = m[2] * nx + m[6] * ny + m[10] * nz;
          const wl = Math.hypot(wx, wy, wz) || 1;
          normals[i * 3] = wx / wl; normals[i * 3 + 1] = wy / wl; normals[i * 3 + 2] = wz / wl;
        }
        if (uv) { uvs[i * 2] = uv[v * 2]; uvs[i * 2 + 1] = uv[v * 2 + 1]; }
      }
      const material = prim.getMaterial();
      const factor = material?.getBaseColorFactor() ?? [0.8, 0.8, 0.8, 1];
      fragments.push({
        tris, normals, uvs,
        texture: await decode(material?.getBaseColorTexture() ?? null),
        color: [factor[0], factor[1], factor[2]],
      });
    }
  }
  return fragments;
}

function frameOf(fragments: Fragment[]): RenderFrame {
  const minV = [Infinity, Infinity, Infinity], maxV = [-Infinity, -Infinity, -Infinity];
  for (const f of fragments) {
    for (let i = 0; i < f.tris.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        if (f.tris[i + a] < minV[a]) minV[a] = f.tris[i + a];
        if (f.tris[i + a] > maxV[a]) maxV[a] = f.tris[i + a];
      }
    }
  }
  if (!Number.isFinite(minV[0])) return { center: [0, 0, 0], radius: 1 };
  return {
    center: [(minV[0] + maxV[0]) / 2, (minV[1] + maxV[1]) / 2, (minV[2] + maxV[2]) / 2],
    radius: Math.max(maxV[0] - minV[0], maxV[1] - minV[1], maxV[2] - minV[2]) / 2 || 1,
  };
}

/** World-space framing of a document's default scene (no textures decoded). */
export async function computeFrame(doc: Document): Promise<RenderFrame> {
  return frameOf(await gatherFragments(doc, undefined));
}

/** Render to raw RGBA views. Needs no image codec unless a decoder is passed. */
export async function renderRaw(doc: Document, opts: RenderOptions = {}): Promise<RawView[]> {
  const fragments = await gatherFragments(doc, opts.textureDecoder);
  return renderRawFragments(fragments, opts);
}

/** Framing of a fragment list (what `computeFrame` does for a document). */
export function frameOfFragments(fragments: Fragment[]): RenderFrame {
  return frameOf(fragments);
}

/**
 * Render already-gathered fragments (world-space triangles). This is the
 * body of `renderRaw`; the posed / USD paths build their own fragments and
 * come through here so every input shares one rasterizer.
 */
export function renderRawFragments(fragments: Fragment[], opts: RenderOptions = {}): RawView[] {
  const size = opts.size ?? 512;
  const cameras = opts.cameras ?? defaultRig();
  const { center, radius } = opts.frame ?? frameOf(fragments);

  const views: RawView[] = [];
  for (const cam of cameras) {
    const distance = radius / Math.tan((cam.fovDeg * Math.PI) / 360) * 1.35;
    const eye: [number, number, number] = cam.absolute ? cam.position : [
      center[0] + cam.position[0] * distance,
      center[1] + cam.position[1] * distance,
      center[2] + cam.position[2] * distance,
    ];
    const target = cam.absolute && cam.target ? cam.target : center;
    const ss = Math.max(1, Math.floor(opts.supersample ?? 1));
    const hi = rasterize(fragments, eye, target, cam.fovDeg, size * ss);
    const { rgba, mask } = ss === 1 ? hi : downsample(hi.rgba, hi.mask, size, ss);
    views.push({ name: cam.name, rgba, mask, size, camera: { position: eye, target, fovDeg: cam.fovDeg } });
  }
  return views;
}

/** Render to PNGs (Node: textures decoded and pixels encoded with sharp). */
export async function renderViews(
  doc: Document,
  opts: { size?: number; cameras?: RenderCamera[]; frame?: RenderFrame } = {},
): Promise<RenderedView[]> {
  const sharp = (await import('sharp')).default;
  const raw = await renderRaw(doc, { ...opts, textureDecoder: sharpTextureDecoder() });
  const views: RenderedView[] = [];
  for (const v of raw) {
    const png = new Uint8Array(
      await sharp(Buffer.from(v.rgba), { raw: { width: v.size, height: v.size, channels: 4 } })
        .png().toBuffer(),
    );
    views.push({ name: v.name, png, camera: v.camera });
  }
  return views;
}

/**
 * Box-filter an RGBA image by an integer factor; mask = any covered sample.
 * The average is taken in LINEAR light and re-encoded, which is what a GPU
 * does when it resolves multisamples into an sRGB framebuffer; averaging the
 * encoded bytes instead would darken every antialiased edge.
 */
function downsample(
  rgba: Uint8Array, mask: Uint8Array, size: number, ss: number,
): { rgba: Uint8Array; mask: Uint8Array } {
  const big = size * ss;
  const out = new Uint8Array(size * size * 4);
  const outMask = new Uint8Array(size * size);
  const n = ss * ss;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, m = 0;
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const p = (y * ss + dy) * big + (x * ss + dx);
          r += SRGB8_TO_LINEAR[rgba[p * 4]];
          g += SRGB8_TO_LINEAR[rgba[p * 4 + 1]];
          b += SRGB8_TO_LINEAR[rgba[p * 4 + 2]];
          m |= mask[p];
        }
      }
      const o = y * size + x;
      out[o * 4] = linearToSrgb8(r / n); out[o * 4 + 1] = linearToSrgb8(g / n); out[o * 4 + 2] = linearToSrgb8(b / n); out[o * 4 + 3] = 255;
      outMask[o] = m;
    }
  }
  return { rgba: out, mask: outMask };
}

/**
 * Nearest-neighbour texel index for a wrapped UV — no bilinear filter and no
 * mip pyramid, deliberately:
 *
 * - Point sampling is exactly reproducible; a mip chain would mean choosing a
 *   level from screen-space UV derivatives, and the level a fragment lands on
 *   flips on rounding, which is how a "deterministic" renderer stops being
 *   one across platforms.
 * - The cost is real: the renderer is blind to minification aliasing that a
 *   viewer would show as shimmer on a dense, high-frequency texture.
 * - Two things blunt it. The Node decoder box-filters every texture down to
 *   512px on load (one crude mip level, applied before any sampling), and
 *   verification renders at 2x supersampling, so each output pixel already
 *   averages four texel fetches.
 *
 * Texture-space fidelity is what `analyze`'s texture rules and the KTX2 path
 * measure directly; SSIM here measures shape and shading. If that changes,
 * the honest fix is derivative-based mip selection with a fixed rounding
 * rule — not bilinear, which would only hide the aliasing at one scale.
 */
function sampleTexel(texture: DecodedTexture, u: number, v: number): number {
  const tx = Math.min(texture.width - 1, Math.max(0, Math.floor((u % 1 + 1) % 1 * texture.width)));
  const ty = Math.min(texture.height - 1, Math.max(0, Math.floor((v % 1 + 1) % 1 * texture.height)));
  return (ty * texture.width + tx) * 4;
}

function rasterize(
  fragments: Fragment[],
  eye: [number, number, number],
  target: [number, number, number],
  fovDeg: number,
  size: number,
): { rgba: Uint8Array; mask: Uint8Array } {
  // Camera basis: forward, right = forward × up(0,1,0), up = right × forward.
  let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2];
  const fl = Math.hypot(fx, fy, fz); fx /= fl; fy /= fl; fz /= fl;
  let rx = -fz, ry = 0, rz = fx;
  const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;

  const focal = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const color = new Uint8Array(size * size * 4);
  const mask = new Uint8Array(size * size);
  const depth = new Float32Array(size * size).fill(Infinity);
  // Neutral studio background.
  for (let i = 0; i < size * size; i++) {
    color[i * 4] = 24; color[i * 4 + 1] = 25; color[i * 4 + 2] = 28; color[i * 4 + 3] = 255;
  }
  const light: [number, number, number] = [0.5, 0.75, 0.42];
  const ll = Math.hypot(...light); light[0] /= ll; light[1] /= ll; light[2] /= ll;

  const project = (x: number, y: number, z: number): [number, number, number] => {
    const dx = x - eye[0], dy = y - eye[1], dz = z - eye[2];
    const cz = dx * fx + dy * fy + dz * fz;
    const cx = dx * rx + dy * ry + dz * rz;
    const cy = dx * ux + dy * uy + dz * uz;
    return [
      (cx / cz) * focal * (size / 2) + size / 2,
      -(cy / cz) * focal * (size / 2) + size / 2,
      cz,
    ];
  };

  for (const frag of fragments) {
    const t = frag.tris, uv = frag.uvs;
    for (let i = 0; i < t.length; i += 9) {
      const A = project(t[i], t[i + 1], t[i + 2]);
      const B = project(t[i + 3], t[i + 4], t[i + 5]);
      const C = project(t[i + 6], t[i + 7], t[i + 8]);
      if (A[2] <= 0 || B[2] <= 0 || C[2] <= 0) continue;

      // Face normal as the fallback when the mesh has no usable normals.
      const e1 = [t[i + 3] - t[i], t[i + 4] - t[i + 1], t[i + 5] - t[i + 2]];
      const e2 = [t[i + 6] - t[i], t[i + 7] - t[i + 1], t[i + 8] - t[i + 2]];
      let fnx = e1[1] * e2[2] - e1[2] * e2[1];
      let fny = e1[2] * e2[0] - e1[0] * e2[2];
      let fnz = e1[0] * e2[1] - e1[1] * e2[0];
      const fnl = Math.hypot(fnx, fny, fnz) || 1; fnx /= fnl; fny /= fnl; fnz /= fnl;
      const n = frag.normals;
      const hasNormals = n[i] !== 0 || n[i + 1] !== 0 || n[i + 2] !== 0;

      const minX = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0])));
      const maxX = Math.min(size - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
      const minY = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1])));
      const maxY = Math.min(size - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
      const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
      if (Math.abs(area) < 1e-9) continue;

      const j = (i / 9) * 6;
      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const w0 = ((B[0] - px) * (C[1] - py) - (B[1] - py) * (C[0] - px)) / area;
          const w1 = ((C[0] - px) * (A[1] - py) - (C[1] - py) * (A[0] - px)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = 1 / (w0 / A[2] + w1 / B[2] + w2 / C[2]);
          const p = py * size + px;
          if (z >= depth[p]) continue;
          depth[p] = z;
          mask[p] = 1;

          // Smooth (Gouraud-style) shading from interpolated vertex normals.
          let nx = fnx, ny = fny, nz = fnz;
          if (hasNormals) {
            nx = w0 * n[i] + w1 * n[i + 3] + w2 * n[i + 6];
            ny = w0 * n[i + 1] + w1 * n[i + 4] + w2 * n[i + 7];
            nz = w0 * n[i + 2] + w1 * n[i + 5] + w2 * n[i + 8];
            const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
          }
          const lambert = 0.35 + 0.65 * Math.abs(nx * light[0] + ny * light[1] + nz * light[2]);

          // Linear base colour. glTF defines it as factor * texture, both in
          // linear light: the factor is stored linear, texels are sRGB bytes.
          // Multiplying (rather than letting the texture win) is what makes
          // prune()'s fold of a solid texture into the factor a no-op here.
          let r = frag.color[0], g = frag.color[1], b = frag.color[2];
          if (frag.texture && uv.length) {
            // Perspective-correct UV.
            const iu = (w0 * uv[j] / A[2] + w1 * uv[j + 2] / B[2] + w2 * uv[j + 4] / C[2]) * z;
            const iv = (w0 * uv[j + 1] / A[2] + w1 * uv[j + 3] / B[2] + w2 * uv[j + 5] / C[2]) * z;
            const ti = sampleTexel(frag.texture, iu, iv);
            r *= SRGB8_TO_LINEAR[frag.texture.rgba[ti]];
            g *= SRGB8_TO_LINEAR[frag.texture.rgba[ti + 1]];
            b *= SRGB8_TO_LINEAR[frag.texture.rgba[ti + 2]];
          }
          // Shade in linear, write display-referred sRGB.
          color[p * 4] = linearToSrgb8(r * lambert);
          color[p * 4 + 1] = linearToSrgb8(g * lambert);
          color[p * 4 + 2] = linearToSrgb8(b * lambert);
        }
      }
    }
  }

  return { rgba: color, mask };
}
