import { Document } from '@gltf-transform/core';
import { pointInLoop, traceMask, type Loop } from './trace.js';
import { buildExtrusion, type ExtrudeStats } from './build.js';
import { quantizeColors, srgbToLinear } from './layers.js';
import { distanceTransform, sampleDistance } from './relief.js';
import { KHRMaterialsTransmission } from '@gltf-transform/extensions';
import type { Material, Texture } from '@gltf-transform/core';

export interface ExtrudeOptions {
  /** Solid-pixel test: 'alpha' (transparent bg) or 'luma' (white bg). Auto-detected by default. */
  mode?: 'alpha' | 'luma';
  /** Threshold 0-255. Default: alpha 128, luma 245 (pixels darker than this are solid). */
  threshold?: number;
  /** Douglas-Peucker tolerance in trace pixels. Default 1.2. */
  simplify?: number;
  /** Contour smoothing iterations (angle-aware Chaikin): rounds staircase
   *  noise while keeping intentional sharp corners. Default 2; 0 = off. */
  smoothing?: number;
  /** World width in meters. Default 1. */
  width?: number;
  /** Extrusion depth in meters. Default width * 0.08. */
  depth?: number;
  /** Bevel radius on both rims (meters). 0 = hard edge (default). */
  bevel?: number;
  /** Bevel roundness: 1 = chamfer, 3+ = rounded. Default 3. */
  bevelSegments?: number;
  /** Layered color extrusion: quantize into this many color layers (2-6).
   *  Each layer extrudes at a stepped depth with a flat material in its
   *  cluster color — the "layered acrylic" look. Omit/0 = single layer. */
  layers?: number;
  /** Extra depth per layer (meters). Default depth * 0.5. */
  layerStep?: number;
  /** Pillow relief: puffy-sticker dome height (meters) on the front face.
   *  0/omit = flat. Supersedes bevel (the pillow IS the rounded profile). */
  pillow?: number;
  /** Luminance micro-relief (meters): brighter artwork rises, darker sinks —
   *  the engraved/sculpted read. Fades to zero at contours so the mesh stays
   *  sealed. Combines with pillow. Try depth * 0.15. */
  emboss?: number;
  /** Material preset applied to all forge materials. */
  preset?: 'enamel' | 'chrome' | 'neon' | 'acrylic' | 'rubber';
  /** Project the source image onto the mesh as baseColor. Default true. */
  texture?: boolean;
  /** Flat base color (used when texture=false), e.g. [1, 0.2, 0.6, 1]. */
  color?: [number, number, number, number];
  metallic?: number;
  roughness?: number;
  /** Pre-encoded artwork to project as baseColor (browser path; Node's
   *  extrudeImage generates this via sharp automatically). */
  textureBytes?: { bytes: Uint8Array; mimeType: string };
}

export interface LayerInfo {
  color: [number, number, number];
  depth: number;
  triangles: number;
}

export interface ExtrudeResult {
  doc: Document;
  stats: ExtrudeStats & {
    mode: 'alpha' | 'luma';
    traceWidth: number;
    traceHeight: number;
    layerInfo?: LayerInfo[];
  };
}

const TRACE_MAX = 1024; // tracing resolution cap; texture keeps up to 2048

/**
 * Turn a logo/graphic image into an extruded 3D GLB document (Node entry).
 * Accepts PNG/JPEG/WebP — and SVG, which sharp rasterizes at high density
 * before tracing. Browsers decode with canvas and call extrudeFromRgba.
 */
export async function extrudeImage(
  imageBytes: Uint8Array,
  opts: ExtrudeOptions = {},
): Promise<ExtrudeResult> {
  const sharp = (await import('sharp')).default;
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
  const raw = await sharp(imageBytes)
    .resize(TRACE_MAX, TRACE_MAX, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let textureBytes = opts.textureBytes;
  if (opts.texture !== false && !textureBytes) {
    const png = await sharp(imageBytes)
      .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    textureBytes = { bytes: new Uint8Array(png), mimeType: 'image/png' };
  }

  return extrudeFromRgba(
    new Uint8Array(raw.data), raw.info.width, raw.info.height,
    { ...opts, textureBytes },
  );
}

/**
 * Pure, environment-agnostic extrusion from decoded RGBA pixels (row-major,
 * 4 bytes/px). This is the whole pipeline minus image decoding — safe in
 * browsers, workers, and Node alike.
 */
export async function extrudeFromRgba(
  px: Uint8Array,
  tw: number,
  th: number,
  opts: ExtrudeOptions = {},
): Promise<ExtrudeResult> {
  // Auto mode: alpha if the alpha channel actually varies.
  let hasAlpha = false;
  for (let i = 3; i < px.length; i += 4) {
    if (px[i] < 250) { hasAlpha = true; break; }
  }
  const mode = opts.mode ?? (hasAlpha ? 'alpha' : 'luma');

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

  const loops = cleanLoops(
    traceMask(mask, tw, th, { simplify: opts.simplify ?? 1.2 }), tw, th,
    opts.smoothing ?? 2,
  );
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

  if (opts.layers && opts.layers >= 2) {
    return extrudeLayered(px, mask, tw, th, mode, opts);
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
    frontHeightFn: makeHeightFn(opts, mask, tw, th, px),
  });

  const material = doc
    .createMaterial('extruded')
    .setMetallicFactor(opts.metallic ?? 0)
    .setRoughnessFactor(opts.roughness ?? 0.6)
    .setDoubleSided(false);
  applyPreset(material, opts.preset, null, 0);

  if (opts.texture !== false && opts.textureBytes) {
    // Project the source artwork via the pixel-space UVs — gradients and
    // glows survive without any painting.
    const texture = doc.createTexture('source')
      .setImage(opts.textureBytes.bytes)
      .setMimeType(opts.textureBytes.mimeType);
    material.setBaseColorTexture(texture);
    if (opts.preset === 'neon') {
      // Glow the artwork itself.
      material.setEmissiveTexture(texture).setEmissiveFactor([1, 1, 1]);
    }
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
  doc.getRoot().getAsset().generator = 'glbforge extrude';

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

/**
 * Angle-aware Chaikin smoothing: staircase vertices (shallow turns) get
 * corner-cut into rounded pairs; deliberate features (sharp turns, like
 * star points and letter corners) are preserved exactly.
 */
function smoothLoop(points: Array<[number, number]>, iterations: number): Array<[number, number]> {
  const SHARP_DEG = 42;
  let current = points;
  for (let iter = 0; iter < iterations; iter++) {
    if (current.length < 6) break;
    const n = current.length;
    const out: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      const prev = current[(i - 1 + n) % n];
      const point = current[i];
      const next = current[(i + 1) % n];
      const a1 = Math.atan2(point[1] - prev[1], point[0] - prev[0]);
      const a2 = Math.atan2(next[1] - point[1], next[0] - point[0]);
      let turn = Math.abs(a2 - a1) * (180 / Math.PI);
      if (turn > 180) turn = 360 - turn;
      if (turn >= SHARP_DEG) {
        out.push(point); // deliberate corner — keep verbatim
      } else {
        // Chaikin corner cut: replace with quarter points of both edges.
        out.push([point[0] * 0.75 + prev[0] * 0.25, point[1] * 0.75 + prev[1] * 0.25]);
        out.push([point[0] * 0.75 + next[0] * 0.25, point[1] * 0.75 + next[1] * 0.25]);
      }
    }
    current = out;
  }
  return current;
}

/** Drop specks and re-derive containment nesting after filtering. */
function cleanLoops(loops: Loop[], width: number, height: number, smoothing = 2): Loop[] {
  const minArea = width * height * 0.00005;
  const kept = loops.filter((l) => l.area >= minArea);
  if (smoothing > 0) {
    for (const loop of kept) loop.points = smoothLoop(loop.points, smoothing);
  }
  for (let i = 0; i < kept.length; i++) {
    const containers: number[] = [];
    for (let j = 0; j < kept.length; j++) {
      if (i !== j && pointInLoop(kept[i].points[0], kept[j].points)) containers.push(j);
    }
    kept[i].depth = containers.length;
    kept[i].parent = containers.length
      ? containers.reduce((best, j) => (kept[j].area < kept[best].area ? j : best), containers[0])
      : -1;
  }
  return kept;
}

/**
 * Layered color extrusion: cluster the artwork's colors, trace each color
 * region, and extrude each at a stepped depth (backs coplanar). One
 * primitive + flat material per layer; larger-area colors sit lower so
 * details pop forward.
 */
async function extrudeLayered(
  px: Uint8Array,
  mask: Uint8Array,
  tw: number,
  th: number,
  mode: 'alpha' | 'luma',
  opts: ExtrudeOptions,
): Promise<ExtrudeResult> {
  const k = Math.min(6, Math.max(2, opts.layers!));
  const { labels, colors, counts } = quantizeColors(px, mask, tw, th, k);

  const width = opts.width ?? 1;
  const baseDepth = opts.depth ?? width * 0.08;
  const step = opts.layerStep ?? baseDepth * 0.5;

  // Larger-area clusters are backdrop; smaller ones pop forward.
  const order = colors
    .map((_, c) => c)
    .filter((c) => counts[c] > 0)
    .sort((a, b) => counts[b] - counts[a]);

  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene('scene');
  const stats = {
    loops: 0, outerLoops: 0, holes: 0, triangles: 0, vertices: 0,
    mode, traceWidth: tw, traceHeight: th,
    layerInfo: [] as LayerInfo[],
  };

  let totalContours = 0;
  for (const [layerIdx, cluster] of order.entries()) {
    const layerMask = new Uint8Array(tw * th);
    for (let i = 0; i < layerMask.length; i++) layerMask[i] = labels[i] === cluster ? 1 : 0;
    const loops = cleanLoops(
      traceMask(layerMask, tw, th, { simplify: opts.simplify ?? 1.2 }), tw, th,
      opts.smoothing ?? 2,
    );
    totalContours += loops.length;
    if (totalContours > 300) {
      throw new Error(
        'Layered tracing produced too many contours — the image looks photographic. ' +
        'Use fewer layers, a cleaner graphic, or Meshy image-to-3D for photos.',
      );
    }
    if (loops.filter((l) => l.depth % 2 === 0).length === 0) continue;

    const depth = baseDepth + layerIdx * step;
    const geo = buildExtrusion(doc, loops, {
      width: opts.width,
      depth,
      bevel: opts.bevel,
      bevelSegments: opts.bevelSegments,
      imageWidth: tw,
      imageHeight: th,
      frontHeightFn: makeHeightFn(opts, layerMask, tw, th, px),
    });

    const [r, g, b] = colors[cluster];
    const linear: [number, number, number] = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
    const material = doc
      .createMaterial(`layer-${layerIdx}`)
      .setMetallicFactor(opts.metallic ?? 0)
      .setRoughnessFactor(opts.roughness ?? 0.45);
    if (opts.texture !== false && opts.textureBytes) {
      // Project the artwork onto the layer: gradients and glows survive
      // (walls sample their nearest edge pixels, which reads as printed
      // edges on the layered-acrylic look).
      material.setBaseColorTexture(sharedTexture(doc, opts.textureBytes));
      if (opts.preset === 'neon') {
        material.setEmissiveTexture(sharedTexture(doc, opts.textureBytes)).setEmissiveFactor([1, 1, 1]);
      }
    } else {
      material.setBaseColorFactor([...linear, 1]);
    }
    applyPreset(material, opts.preset, opts.textureBytes ? null : linear, layerIdx);

    const buffer = doc.getRoot().listBuffers()[0];
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(geo.positions).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(geo.normals).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(geo.uvs).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(geo.indices).setBuffer(buffer))
      .setMaterial(material);
    const mesh = doc.createMesh(`layer-${layerIdx}`).addPrimitive(prim);
    // Backs coplanar: each build centers on its own depth, so shift by half
    // the extra depth this layer has over the base layer.
    const node = doc.createNode(`layer-${layerIdx}`).setMesh(mesh)
      .setTranslation([0, 0, (depth - baseDepth) / 2]);
    scene.addChild(node);

    stats.loops += geo.stats.loops;
    stats.outerLoops += geo.stats.outerLoops;
    stats.holes += geo.stats.holes;
    stats.triangles += geo.stats.triangles;
    stats.vertices += geo.stats.vertices;
    stats.layerInfo.push({ color: colors[cluster], depth, triangles: geo.stats.triangles });
  }

  if (stats.layerInfo.length === 0) {
    throw new Error('No layers produced any shapes — try fewer layers or a different threshold.');
  }
  doc.getRoot().getAsset().generator = 'glbforge extrude';
  return { doc, stats };
}

/**
 * Front-cap height field: pillow dome (EDT sqrt profile) plus luminance
 * micro-relief, both fading to zero at contours so walls stay sealed.
 */
function makeHeightFn(
  opts: ExtrudeOptions,
  mask: Uint8Array,
  tw: number,
  th: number,
  px?: Uint8Array,
): ((x: number, y: number) => number) | undefined {
  const pillowM = opts.pillow ?? 0;
  const embossM = opts.emboss ?? 0;
  if (pillowM <= 0 && embossM === 0) return undefined;
  const width = opts.width ?? 1;
  const scale = width / tw; // meters per trace px
  const rolloffPx = Math.max(4, pillowM / scale);
  const dist = distanceTransform(mask, tw, th);

  // Blurred luminance map (3x3 box) for the relief signal.
  let luma: Float32Array | null = null;
  if (embossM !== 0 && px) {
    const raw = new Float32Array(tw * th);
    for (let i = 0; i < tw * th; i++) {
      raw[i] = (px[i * 4] * 0.2126 + px[i * 4 + 1] * 0.7152 + px[i * 4 + 2] * 0.0722) / 255;
    }
    luma = new Float32Array(tw * th);
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        let sum = 0, count = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < tw && ny < th) { sum += raw[ny * tw + nx]; count++; }
        }
        luma[y * tw + x] = sum / count;
      }
    }
  }
  const embossFadePx = Math.max(3, Math.abs(embossM) / scale * 1.5);

  return (x, y) => {
    const d = sampleDistance(dist, tw, th, x, y);
    let h = pillowM > 0 ? pillowM * Math.sqrt(Math.min(d, rolloffPx) / rolloffPx) : 0;
    if (luma) {
      const xi = Math.min(tw - 1, Math.max(0, Math.round(x)));
      const yi = Math.min(th - 1, Math.max(0, Math.round(y)));
      const fade = Math.min(1, d / embossFadePx);
      h += embossM * (luma[yi * tw + xi] - 0.5) * 2 * fade;
    }
    return h;
  };
}

/** One texture object per document, shared across layer materials. */
const textureCache = new WeakMap<Document, Texture>();
function sharedTexture(doc: Document, source: { bytes: Uint8Array; mimeType: string }): Texture {
  let texture = textureCache.get(doc);
  if (!texture) {
    texture = doc.createTexture('source').setImage(source.bytes).setMimeType(source.mimeType);
    textureCache.set(doc, texture);
  }
  return texture;
}

/**
 * Forge material presets. Layer-aware where it matters: a real enamel pin
 * is a polished metal base with glossy enamel fills, so layer 0 goes
 * metallic and upper layers go gloss.
 */
function applyPreset(
  material: Material,
  preset: ExtrudeOptions['preset'],
  layerColor: [number, number, number] | null,
  layerIdx: number,
): void {
  if (!preset) return;
  switch (preset) {
    case 'enamel':
      if (layerIdx === 0) material.setMetallicFactor(1).setRoughnessFactor(0.35);
      else material.setMetallicFactor(0.1).setRoughnessFactor(0.18);
      break;
    case 'chrome':
      material.setMetallicFactor(1).setRoughnessFactor(0.08);
      break;
    case 'rubber':
      material.setMetallicFactor(0).setRoughnessFactor(0.95);
      break;
    case 'neon':
      material.setRoughnessFactor(0.4);
      if (layerColor) {
        material.setEmissiveFactor(layerColor);
        material.setBaseColorFactor([layerColor[0] * 0.15, layerColor[1] * 0.15, layerColor[2] * 0.15, 1]);
      }
      // Textured neon is wired at the texture-assignment site.
      break;
    case 'acrylic': {
      const document = Document.fromGraph(material.getGraph())!;
      const transmission = document.createExtension(KHRMaterialsTransmission);
      material.setExtension(
        'KHR_materials_transmission',
        transmission.createTransmission().setTransmissionFactor(0.85),
      );
      material.setRoughnessFactor(0.1).setMetallicFactor(0);
      break;
    }
  }
}
