import { Document } from '@gltf-transform/core';
import sharp from 'sharp';
import { pointInLoop as pointInLoopPub, traceMask, type Loop } from './trace.js';
import { buildExtrusion, type ExtrudeStats } from './build.js';

export interface ExtrudeOptions {
  /** Solid-pixel test: 'alpha' (transparent bg) or 'luma' (white bg). Auto-detected by default. */
  mode?: 'alpha' | 'luma';
  /** Threshold 0-255. Default: alpha 128, luma 245 (pixels darker than this are solid). */
  threshold?: number;
  /** Douglas-Peucker tolerance in trace pixels. Default 1.2. */
  simplify?: number;
  /** World width in meters. Default 1. */
  width?: number;
  /** Extrusion depth in meters. Default width * 0.08. */
  depth?: number;
  /** Bevel radius on both rims (meters). 0 = hard edge (default). */
  bevel?: number;
  /** Bevel roundness: 1 = chamfer, 3+ = rounded. Default 3. */
  bevelSegments?: number;
  /** Project the source image onto the mesh as baseColor. Default true. */
  texture?: boolean;
  /** Flat base color (used when texture=false), e.g. [1, 0.2, 0.6, 1]. */
  color?: [number, number, number, number];
  metallic?: number;
  roughness?: number;
}

export interface ExtrudeResult {
  doc: Document;
  stats: ExtrudeStats & { mode: 'alpha' | 'luma'; traceWidth: number; traceHeight: number };
}

const TRACE_MAX = 1024; // tracing resolution cap; texture keeps up to 2048

/**
 * Turn a logo/graphic image into an extruded 3D GLB document.
 * Accepts PNG/JPEG/WebP — and SVG, which sharp rasterizes at high density
 * before tracing (the marching-squares grid is the accuracy limit either
 * way, so rasterized vectors lose nothing at trace resolution).
 */
export async function extrudeImage(
  imageBytes: Uint8Array,
  opts: ExtrudeOptions = {},
): Promise<ExtrudeResult> {
  // SVG inputs get rasterized generously so the trace grid is saturated.
  const isSvg = looksLikeSvg(imageBytes);
  if (isSvg) {
    imageBytes = new Uint8Array(
      await sharp(Buffer.from(imageBytes), { density: 300 })
        .resize(TRACE_MAX * 2, TRACE_MAX * 2, { fit: 'inside', withoutEnlargement: false })
        .png()
        .toBuffer(),
    );
  }
  const meta = await sharp(imageBytes).metadata();
  const hasAlpha = meta.hasAlpha ?? false;
  const mode = opts.mode ?? (hasAlpha ? 'alpha' : 'luma');

  const raw = await sharp(imageBytes)
    .resize(TRACE_MAX, TRACE_MAX, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: tw, height: th } = raw.info;
  const px = raw.data;

  const mask = new Uint8Array(tw * th);
  if (mode === 'alpha') {
    const threshold = opts.threshold ?? 128;
    for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4 + 3] >= threshold ? 1 : 0;
  } else {
    const threshold = opts.threshold ?? 245;
    for (let i = 0; i < mask.length; i++) {
      const luma = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
      mask[i] = luma < threshold && px[i * 4 + 3] >= 128 ? 1 : 0;
    }
  }

  let loops: Loop[] = traceMask(mask, tw, th, { simplify: opts.simplify ?? 1.2 });
  // Drop specks (< 0.005% of image area) — antialiasing noise, not shapes.
  const minArea = tw * th * 0.00005;
  loops = loops.filter((l) => l.area >= minArea);
  // Re-derive nesting after filtering (parents may be gone).
  loops.forEach((l, i) => {
    l.depth = 0; l.parent = -1;
    // recomputed below
  });
  for (let i = 0; i < loops.length; i++) {
    const containers: number[] = [];
    for (let j = 0; j < loops.length; j++) {
      if (i !== j && pointInLoopPub(loops[i].points[0], loops[j].points)) containers.push(j);
    }
    loops[i].depth = containers.length;
    if (containers.length) {
      loops[i].parent = containers.reduce((best, j) =>
        loops[j].area < loops[best].area ? j : best, containers[0]);
    }
  }

  if (loops.length > 150) {
    throw new Error(
      `Traced ${loops.length} contours — this looks like a photograph or a noisy mask, ` +
      'not flat artwork. Extrusion is for logos/graphics with clean silhouettes; ' +
      'for photos of objects use Meshy image-to-3D instead, or pass an explicit ' +
      '--mode/--threshold to isolate the shape.',
    );
  }
  if (loops.filter((l) => l.depth % 2 === 0).length === 0) {
    throw new Error(
      `No shapes found (mode=${mode}). For white-background images pass mode "luma"; ` +
      'for transparent-background images pass "alpha"; or adjust the threshold.',
    );
  }

  const doc = new Document();
  doc.createBuffer();
  const geo = buildExtrusion(doc, loops, {
    width: opts.width,
    depth: opts.depth,
    bevel: opts.bevel,
    bevelSegments: opts.bevelSegments,
    imageWidth: tw,
    imageHeight: th,
  });

  const material = doc
    .createMaterial('extruded')
    .setMetallicFactor(opts.metallic ?? 0)
    .setRoughnessFactor(opts.roughness ?? 0.6)
    .setDoubleSided(false);

  if (opts.texture !== false) {
    // Re-encode the source as PNG (capped at 2048) and project it via the
    // pixel-space UVs — gradients and glows survive without any painting.
    const png = await sharp(imageBytes)
      .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    const texture = doc.createTexture('source').setImage(png).setMimeType('image/png');
    material.setBaseColorTexture(texture);
  } else if (opts.color) {
    material.setBaseColorFactor(opts.color);
  }

  const buffer = doc.getRoot().listBuffers()[0];
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(geo.positions).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(geo.normals).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(geo.uvs).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(geo.indices).setBuffer(buffer))
    .setMaterial(material);

  const mesh = doc.createMesh('extrusion').addPrimitive(prim);
  const node = doc.createNode('extrusion').setMesh(mesh);
  doc.createScene('scene').addChild(node);
  doc.getRoot().getAsset().generator = 'xui extrude';

  return { doc, stats: { ...geo.stats, mode, traceWidth: tw, traceHeight: th } };
}

/** Cheap SVG sniff: XML/SVG tag near the start of the buffer. */
function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.slice(0, 512))
    .trimStart()
    .toLowerCase();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
}
