/**
 * Deterministic software renderer for training-pair generation: renders a
 * document from a rig of known cameras into PNGs — no GPU, no browser.
 * Z-buffered rasterizer with barycentric UV texture sampling and a fixed
 * directional light; identical input yields identical pixels.
 */
import { Document, Node, Primitive, Texture } from '@gltf-transform/core';

export interface RenderCamera {
  name: string;
  /** Unit-sphere position, scaled by the framing distance at render time. */
  position: [number, number, number];
  fovDeg: number;
}

export interface RenderedView {
  name: string;
  png: Uint8Array;
  camera: { position: [number, number, number]; target: [number, number, number]; fovDeg: number };
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

interface Fragment {
  tris: Float32Array;     // world xyz * 9 per tri
  uvs: Float32Array;      // uv * 6 per tri
  texture: { rgba: Uint8Array; width: number; height: number } | null;
  color: [number, number, number]; // linear base color factor
}

export async function renderViews(
  doc: Document,
  opts: { size?: number; cameras?: RenderCamera[] } = {},
): Promise<RenderedView[]> {
  const sharp = (await import('sharp')).default;
  const size = opts.size ?? 512;
  const cameras = opts.cameras ?? defaultRig();

  // Decode each texture once.
  const decoded = new Map<Texture, { rgba: Uint8Array; width: number; height: number } | null>();
  const decode = async (texture: Texture | null) => {
    if (!texture) return null;
    if (decoded.has(texture)) return decoded.get(texture)!;
    try {
      const raw = await sharp(Buffer.from(texture.getImage()!))
        .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const entry = { rgba: new Uint8Array(raw.data), width: raw.info.width, height: raw.info.height };
      decoded.set(texture, entry);
      return entry;
    } catch {
      decoded.set(texture, null);
      return null;
    }
  };

  // Gather per-material fragments in world space.
  const fragments: Fragment[] = [];
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (!scene) return [];
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
      const p = pos.getArray()!;
      const uv = prim.getAttribute('TEXCOORD_0')?.getArray() ?? null;
      const idx = prim.getIndices()?.getArray() ?? null;
      const count = idx ? idx.length : pos.getCount();
      const tris = new Float32Array(count * 3);
      const uvs = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) {
        const v = idx ? idx[i] : i;
        const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
        tris[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
        tris[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        tris[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        if (uv) { uvs[i * 2] = uv[v * 2]; uvs[i * 2 + 1] = uv[v * 2 + 1]; }
      }
      const material = prim.getMaterial();
      const factor = material?.getBaseColorFactor() ?? [0.8, 0.8, 0.8, 1];
      fragments.push({
        tris, uvs,
        texture: await decode(material?.getBaseColorTexture() ?? null),
        color: [factor[0], factor[1], factor[2]],
      });
    }
  }

  // Framing: bounding sphere of everything.
  let minV = [Infinity, Infinity, Infinity], maxV = [-Infinity, -Infinity, -Infinity];
  for (const f of fragments) {
    for (let i = 0; i < f.tris.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        if (f.tris[i + a] < minV[a]) minV[a] = f.tris[i + a];
        if (f.tris[i + a] > maxV[a]) maxV[a] = f.tris[i + a];
      }
    }
  }
  const center: [number, number, number] = [
    (minV[0] + maxV[0]) / 2, (minV[1] + maxV[1]) / 2, (minV[2] + maxV[2]) / 2,
  ];
  const radius = Math.max(maxV[0] - minV[0], maxV[1] - minV[1], maxV[2] - minV[2]) / 2 || 1;

  const views: RenderedView[] = [];
  for (const cam of cameras) {
    const distance = radius / Math.tan((cam.fovDeg * Math.PI) / 360) * 1.35;
    const eye: [number, number, number] = [
      center[0] + cam.position[0] * distance,
      center[1] + cam.position[1] * distance,
      center[2] + cam.position[2] * distance,
    ];
    const png = await rasterize(fragments, eye, center, cam.fovDeg, size, sharp as unknown as (input: Buffer, opts: object) => { png(): { toBuffer(): Promise<Buffer> } });
    views.push({ name: cam.name, png, camera: { position: eye, target: center, fovDeg: cam.fovDeg } });
  }
  return views;
}

async function rasterize(
  fragments: Fragment[],
  eye: [number, number, number],
  target: [number, number, number],
  fovDeg: number,
  size: number,
  sharp: (input: Buffer, opts: object) => { png(): { toBuffer(): Promise<Buffer> } },
): Promise<Uint8Array> {
  // Camera basis.
  let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2];
  const fl = Math.hypot(fx, fy, fz); fx /= fl; fy /= fl; fz /= fl;
  let rx = fz * 0 - fy * 1 !== 0 || true ? fy * 0 - fz * 1 : 0; // right = f × up(0,1,0)
  let ry = fz * 0 - fx * 0;
  let rz = fx * 1 - fy * 0;
  rx = fy * 0 - fz * 1; ry = fz * 0 - fx * 0; rz = fx * 1 - fy * 0;
  const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;

  const focal = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const color = new Uint8Array(size * size * 4);
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

      // Face normal for shading (world space).
      const e1 = [t[i + 3] - t[i], t[i + 4] - t[i + 1], t[i + 5] - t[i + 2]];
      const e2 = [t[i + 6] - t[i], t[i + 7] - t[i + 1], t[i + 8] - t[i + 2]];
      let nx = e1[1] * e2[2] - e1[2] * e2[1];
      let ny = e1[2] * e2[0] - e1[0] * e2[2];
      let nz = e1[0] * e2[1] - e1[1] * e2[0];
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      const lambert = 0.35 + 0.65 * Math.abs(nx * light[0] + ny * light[1] + nz * light[2]);

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

          let r = frag.color[0], g = frag.color[1], b = frag.color[2];
          if (frag.texture && uv.length) {
            // Perspective-correct UV.
            const iu = (w0 * uv[j] / A[2] + w1 * uv[j + 2] / B[2] + w2 * uv[j + 4] / C[2]) * z;
            const iv = (w0 * uv[j + 1] / A[2] + w1 * uv[j + 3] / B[2] + w2 * uv[j + 5] / C[2]) * z;
            const tx = Math.min(frag.texture.width - 1, Math.max(0, Math.floor((iu % 1 + 1) % 1 * frag.texture.width)));
            const ty = Math.min(frag.texture.height - 1, Math.max(0, Math.floor((iv % 1 + 1) % 1 * frag.texture.height)));
            const ti = (ty * frag.texture.width + tx) * 4;
            r = frag.texture.rgba[ti] / 255; g = frag.texture.rgba[ti + 1] / 255; b = frag.texture.rgba[ti + 2] / 255;
          }
          color[p * 4] = Math.min(255, Math.round(r * lambert * 255));
          color[p * 4 + 1] = Math.min(255, Math.round(g * lambert * 255));
          color[p * 4 + 2] = Math.min(255, Math.round(b * lambert * 255));
        }
      }
    }
  }

  return new Uint8Array(
    await sharp(Buffer.from(color), { raw: { width: size, height: size, channels: 4 } })
      .png().toBuffer(),
  );
}
