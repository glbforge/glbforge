import { Document, Node, Primitive } from '@gltf-transform/core';

export interface StlOptions {
  /** Scale so the largest dimension prints at this many millimeters. Default 80. */
  targetSizeMm?: number;
  /** Raw scale factor (glTF meters -> STL mm). Overrides targetSizeMm. */
  scale?: number;
}

export interface StlResult {
  stl: Uint8Array;
  triangles: number;
  /** Final printed dimensions in millimeters. */
  sizeMm: [number, number, number];
}

/** Multiply a column-major mat4 by a point. */
function transformPoint(m: number[], x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/**
 * Export a document's default scene as binary STL for 3D printing.
 * World transforms are baked in; glTF's y-up is rotated to the printer's
 * z-up so models stand upright on the build plate; output is scaled to a
 * target size in millimeters (slicers assume mm).
 */
export function toStl(doc: Document, opts: StlOptions = {}): StlResult {
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (!scene) throw new Error('Document has no scene to export.');

  // Gather world-space triangles (y-up -> z-up: [x, -z, y]).
  const verts: number[] = [];
  const visit = (node: Node): void => {
    const mesh = node.getMesh();
    if (mesh) {
      const matrix = [...node.getWorldMatrix()];
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== Primitive.Mode.TRIANGLES) continue;
        const position = prim.getAttribute('POSITION');
        if (!position) continue;
        const pos = position.getArray()!;
        const indices = prim.getIndices()?.getArray() ?? null;
        const count = indices ? indices.length : position.getCount();
        for (let i = 0; i < count; i++) {
          const vi = indices ? indices[i] : i;
          const [wx, wy, wz] = transformPoint(matrix, pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
          verts.push(wx, -wz, wy);
        }
      }
    }
    node.listChildren().forEach(visit);
  };
  scene.listChildren().forEach(visit);

  const triangles = Math.floor(verts.length / 9);
  if (triangles === 0) throw new Error('No triangle geometry found to export.');

  // Scale to millimeters.
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < verts.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      if (verts[i + a] < min[a]) min[a] = verts[i + a];
      if (verts[i + a] > max[a]) max[a] = verts[i + a];
    }
  }
  const extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const scale = opts.scale ?? (opts.targetSizeMm ?? 80) / Math.max(...extent, 1e-9);

  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  new Uint8Array(buffer).set(
    new TextEncoder().encode('glbforge stl export (binary, mm)').slice(0, 80),
  );
  view.setUint32(80, triangles, true);

  let offset = 84;
  for (let t = 0; t < triangles; t++) {
    const i = t * 9;
    const ax = verts[i] * scale, ay = verts[i + 1] * scale, az = verts[i + 2] * scale;
    const bx = verts[i + 3] * scale, by = verts[i + 4] * scale, bz = verts[i + 5] * scale;
    const cx = verts[i + 6] * scale, cy = verts[i + 7] * scale, cz = verts[i + 8] * scale;
    // Face normal from winding.
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const value of [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz]) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }

  return {
    stl: new Uint8Array(buffer),
    triangles,
    sizeMm: [extent[0] * scale, extent[1] * scale, extent[2] * scale] as [number, number, number],
  };
}
