/**
 * Binary USD ("crate", .usdc) writer for the subset of USD that GLBForge
 * emits. Targets crate file version 0.8.0 — what Pixar's own writer emits
 * today and the oldest version its reader does not flag as deprecated. The
 * structural sections use the crate's compressed encodings: token indices
 * through Pixar's 2-bit-code delta integer compression, then TfFastCompression
 * (a chunk byte + an LZ4 block). We emit literal-only LZ4 blocks — valid LZ4,
 * zero compression — because the structural sections are a few KB while the
 * float arrays (which crate stores raw anyway) are the bulk. Every section's
 * byte layout was verified against files written by Pixar's writer and the
 * result is checked by test/usd-oracle.py with Pixar's reader. Deterministic:
 * same layer, same bytes.
 *
 * File layout: bootstrap (88 bytes) · values · TOKENS · STRINGS · FIELDS ·
 * FIELDSETS · PATHS · SPECS · table of contents.
 */
import { isQuat, vectorWidth, type UsdLayer, type UsdPrim, type UsdValue } from './usd-ir.js';

// Crate value types (crateDataTypes.h order).
const T = {
  Bool: 1, Int: 3, Half: 7, Float: 8, Double: 9, String: 10, Token: 11, AssetPath: 12, Matrix4d: 15,
  Quatf: 17, Vec2f: 20, Vec3f: 24, Vec3h: 25, Vec4f: 28, TokenListOp: 32, PathListOp: 34, TokenVector: 41,
  Specifier: 42, Variability: 44, TimeSamples: 46, DoubleVector: 48,
} as const;

/** IEEE 754 binary16 (round-to-nearest-even) for half-typed attributes. */
export function toHalf(v: number): number {
  if (Number.isNaN(v)) return 0x7e00;
  const sign = v < 0 || Object.is(v, -0) ? 0x8000 : 0;
  v = Math.abs(v);
  if (v === Infinity) return sign | 0x7c00;
  if (v === 0) return sign;
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, v);
  const bits = dv.getUint32(0);
  let exp = ((bits >>> 23) & 0xff) - 127 + 15;
  let mant = bits & 0x7fffff;
  if (exp >= 31) return sign | 0x7c00;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - exp;
    let half = mant >> shift;
    if ((mant >> (shift - 1)) & 1 && ((mant & ((1 << (shift - 1)) - 1)) || (half & 1))) half++;
    return sign | half;
  }
  let half = (exp << 10) | (mant >> 13);
  if (mant & 0x1000 && ((mant & 0xfff) || (half & 1))) half++;
  return sign | half;
}
const SPEC_ATTRIBUTE = 1, SPEC_PRIM = 6, SPEC_PSEUDO_ROOT = 7, SPEC_RELATIONSHIP = 8;
const IS_ARRAY = 1n << 63n, IS_INLINED = 1n << 62n;
const HAS_CHILD = 1, HAS_SIBLING = 2, IS_PRIM_PROPERTY = 4;

class Buf {
  private bytes = new Uint8Array(1 << 16);
  length = 0;
  private ensure(n: number) {
    if (this.length + n <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size); next.set(this.bytes); this.bytes = next;
  }
  align(n: number) { const pad = (n - (this.length % n)) % n; this.ensure(pad); this.length += pad; }
  u8(v: number) { this.ensure(1); this.bytes[this.length++] = v & 0xff; }
  u16(v: number) { this.ensure(2); new DataView(this.bytes.buffer).setUint16(this.length, v & 0xffff, true); this.length += 2; }
  u32(v: number) { this.ensure(4); new DataView(this.bytes.buffer).setUint32(this.length, v >>> 0, true); this.length += 4; }
  i64(v: number) { this.ensure(8); new DataView(this.bytes.buffer).setBigInt64(this.length, BigInt(v), true); this.length += 8; }
  i32(v: number) { this.ensure(4); new DataView(this.bytes.buffer).setInt32(this.length, v | 0, true); this.length += 4; }
  u64(v: number | bigint) { this.ensure(8); new DataView(this.bytes.buffer).setBigUint64(this.length, BigInt(v), true); this.length += 8; }
  f32(v: number) { this.ensure(4); new DataView(this.bytes.buffer).setFloat32(this.length, v, true); this.length += 4; }
  f64(v: number) { this.ensure(8); new DataView(this.bytes.buffer).setFloat64(this.length, v, true); this.length += 8; }
  raw(b: Uint8Array) { this.ensure(b.length); this.bytes.set(b, this.length); this.length += b.length; }
  patchU64(at: number, v: number) { new DataView(this.bytes.buffer).setBigUint64(at, BigInt(v), true); }
  done(): Uint8Array { return this.bytes.slice(0, this.length); }
}

interface PathNode { index: number; token: number; isProp: boolean; children: PathNode[] }

export function writeUsdc(layer: UsdLayer): Uint8Array {
  const out = new Buf();
  const enc = new TextEncoder();

  // --- Tables ---------------------------------------------------------------
  const tokens: string[] = [';-)']; // slot 0 mirrors Pixar's writer; never referenced
  const tokenIndex = new Map<string, number>([[';-)', 0]]);
  const tok = (s: string) => {
    let i = tokenIndex.get(s);
    if (i === undefined) { i = tokens.length; tokens.push(s); tokenIndex.set(s, i); }
    return i;
  };
  const strings: number[] = [];
  const str = (s: string) => { strings.push(tok(s)); return strings.length - 1; };
  const paths: string[] = ['/'];
  const pathIndex = new Map<string, number>([['/', 0]]);
  const path = (p: string) => {
    let i = pathIndex.get(p);
    if (i === undefined) { i = paths.length; paths.push(p); pathIndex.set(p, i); }
    return i;
  };
  const fields: Array<{ token: number; rep: bigint }> = [];
  const fieldIndex = new Map<string, number>();
  const field = (name: string, rep: bigint) => {
    const key = `${name}\0${rep}`;
    let i = fieldIndex.get(key);
    if (i === undefined) { i = fields.length; fields.push({ token: tok(name), rep }); fieldIndex.set(key, i); }
    return i;
  };
  const fieldSets: number[] = [];
  const fieldSetIndex = new Map<string, number>();
  const fieldSet = (indices: number[]) => {
    const key = indices.join(',');
    let i = fieldSetIndex.get(key);
    if (i === undefined) { i = fieldSets.length; fieldSets.push(...indices, 0xffffffff); fieldSetIndex.set(key, i); }
    return i;
  };
  const specs: Array<{ path: number; fieldSet: number; type: number }> = [];

  // --- Values (written first, right after the bootstrap block) --------------
  out.raw(new Uint8Array(88));
  const rep = (type: number, payload: number | bigint, flags = 0n) =>
    (BigInt(type) << 48n) | flags | (BigInt(payload) & ((1n << 48n) - 1n));
  const inline = (type: number, payload: number) => rep(type, payload, IS_INLINED);
  const floatBits = (v: number) => { const dv = new DataView(new ArrayBuffer(4)); dv.setFloat32(0, v, true); return dv.getUint32(0, true); };

  const tokenVector = (names: string[]) => {
    const at = out.length;
    out.u64(names.length);
    for (const n of names) out.u32(tok(n));
    return rep(T.TokenVector, at);
  };
  const explicitPathListOp = (targets: string[]) => {
    const at = out.length;
    out.u8(0x03); // IsExplicit | HasExplicitItems
    out.u64(targets.length);
    for (const t of targets) out.u32(path(t));
    return rep(T.PathListOp, at);
  };
  const prependedTokenListOp = (items: string[]) => {
    const at = out.length;
    out.u8(0x20); // HasPrependedItems
    out.u64(items.length);
    for (const s of items) out.u32(tok(s));
    return rep(T.TokenListOp, at);
  };

  const value = (typeName: string, v: UsdValue): bigint => {
    const isArray = typeName.endsWith('[]');
    const base = typeName.replace(/\[\]$/, '');
    const width = vectorWidth(base);
    if (isArray) {
      out.align(8);
      const at = out.length;
      if (base === 'token' || base === 'string' || base === 'asset') {
        const items = v as string[];
        out.u64(items.length);
        for (const s of items) out.u32(tok(s));
        return rep(base === 'token' ? T.Token : base === 'asset' ? T.AssetPath : T.String, at, IS_ARRAY);
      }
      const xs = v as ArrayLike<number>;
      if (base === 'int') {
        out.u64(xs.length);
        for (let i = 0; i < xs.length; i++) out.i32(xs[i]);
        return rep(T.Int, at, IS_ARRAY);
      }
      if (base === 'half') {
        out.u64(xs.length);
        for (let i = 0; i < xs.length; i++) out.u16(toHalf(xs[i]));
        return rep(T.Half, at, IS_ARRAY);
      }
      if (base === 'float' || base === 'double' || width === 0) {
        out.u64(xs.length);
        if (base === 'double') { for (let i = 0; i < xs.length; i++) out.f64(xs[i]); return rep(T.Double, at, IS_ARRAY); }
        for (let i = 0; i < xs.length; i++) out.f32(xs[i]);
        return rep(T.Float, at, IS_ARRAY);
      }
      if (base === 'matrix4d') {
        const count = Math.floor(xs.length / 16);
        out.u64(count);
        for (let i = 0; i < count * 16; i++) out.f64(xs[i]);
        return rep(T.Matrix4d, at, IS_ARRAY);
      }
      const count = Math.floor(xs.length / width);
      out.u64(count);
      if (base === 'half3') {
        for (let i = 0; i < count * 3; i++) out.u16(toHalf(xs[i]));
        return rep(T.Vec3h, at, IS_ARRAY);
      }
      for (let i = 0; i < count * width; i++) out.f32(xs[i]); // quats: IR is (x,y,z,w) = GfQuatf memory order
      return rep(isQuat(base) ? T.Quatf : width === 2 ? T.Vec2f : width === 3 ? T.Vec3f : T.Vec4f, at, IS_ARRAY);
    }
    switch (base) {
      case 'bool': return inline(T.Bool, v ? 1 : 0);
      case 'int': return inline(T.Int, (v as number) >>> 0);
      case 'float': return inline(T.Float, floatBits(v as number));
      case 'double': { out.align(8); const at = out.length; out.f64(v as number); return rep(T.Double, at); }
      case 'token': return inline(T.Token, tok(String(v)));
      case 'asset': return inline(T.AssetPath, tok(String(v)));
      case 'string': return inline(T.String, str(String(v)));
      case 'matrix4d': {
        out.align(8); const at = out.length;
        const m = v as ArrayLike<number>;
        for (let i = 0; i < 16; i++) out.f64(m[i]);
        return rep(T.Matrix4d, at);
      }
      default: {
        if (!width) throw new Error(`usdc: unsupported attribute type "${typeName}"`);
        out.align(4); const at = out.length;
        const xs = v as ArrayLike<number>;
        for (let i = 0; i < width; i++) out.f32(xs[i]);
        return rep(isQuat(base) ? T.Quatf : width === 2 ? T.Vec2f : width === 3 ? T.Vec3f : T.Vec4f, at);
      }
    }
  };

  /**
   * TimeSamples: [int64 offset to the times rep][u64 n, double times...]
   * [ValueRep DoubleVector -> that inline block][int64 8][u64 n][ValueRep per sample].
   * Identical time arrays share one inline block, as Pixar's writer does.
   */
  const timesBlocks = new Map<string, number>();
  const timeSamples = (typeName: string, times: number[], values: UsdValue[]): bigint => {
    const valueReps = values.map((v) => value(typeName, v));
    const key = times.join(',');
    let timesAt = timesBlocks.get(key);
    out.align(8);
    const at = out.length;
    if (timesAt === undefined) {
      out.i64(8 + 8 + 8 * times.length);
      timesAt = out.length;
      out.u64(times.length);
      for (const t of times) out.f64(t);
      timesBlocks.set(key, timesAt);
    } else {
      out.i64(8);
    }
    out.u64(rep(T.DoubleVector, timesAt));
    out.i64(8);
    out.u64(valueReps.length);
    for (const r of valueReps) out.u64(r);
    return rep(T.TimeSamples, at);
  };

  // --- Specs ------------------------------------------------------------------
  const rootFields = [
    field('defaultPrim', inline(T.Token, tok(layer.defaultPrim))),
  ];
  if (layer.endTimeCode !== undefined) rootFields.push(field('endTimeCode', value('double', layer.endTimeCode)));
  if (layer.framesPerSecond !== undefined) rootFields.push(field('framesPerSecond', value('double', layer.framesPerSecond)));
  rootFields.push(field('metersPerUnit', value('double', layer.metersPerUnit)));
  if (layer.startTimeCode !== undefined) rootFields.push(field('startTimeCode', value('double', layer.startTimeCode)));
  if (layer.timeCodesPerSecond !== undefined) rootFields.push(field('timeCodesPerSecond', value('double', layer.timeCodesPerSecond)));
  rootFields.push(field('upAxis', inline(T.Token, tok(layer.upAxis))));
  if (layer.doc) rootFields.push(field('documentation', value('string', layer.doc)));
  rootFields.push(field('primChildren', tokenVector(layer.prims.map((p) => p.name))));
  specs.push({ path: 0, fieldSet: fieldSet(rootFields), type: SPEC_PSEUDO_ROOT });

  const root: PathNode = { index: 0, token: tok(''), isProp: false, children: [] };

  const visit = (prim: UsdPrim, parent: PathNode) => {
    const node: PathNode = { index: path(prim.path), token: tok(prim.name), isProp: false, children: [] };
    parent.children.push(node);
    const fs = [
      field('specifier', inline(T.Specifier, 0)),
      field('typeName', inline(T.Token, tok(prim.typeName))),
    ];
    if (prim.apiSchemas?.length) fs.push(field('apiSchemas', prependedTokenListOp(prim.apiSchemas)));
    if (prim.children.length) fs.push(field('primChildren', tokenVector(prim.children.map((c) => c.name))));
    if (prim.properties.length) fs.push(field('properties', tokenVector(prim.properties.map((p) => p.name))));
    specs.push({ path: node.index, fieldSet: fieldSet(fs), type: SPEC_PRIM });

    for (const prop of prim.properties) {
      const ppath = `${prim.path}.${prop.name}`;
      const pnode: PathNode = { index: path(ppath), token: tok(prop.name), isProp: true, children: [] };
      node.children.push(pnode);
      if (prop.kind === 'relationship') {
        const rfs = [
          field('variability', inline(T.Variability, 1)),
          field('targetPaths', explicitPathListOp(prop.targets)),
        ];
        specs.push({ path: pnode.index, fieldSet: fieldSet(rfs), type: SPEC_RELATIONSHIP });
        continue;
      }
      const afs = [
        field('custom', inline(T.Bool, 0)),
        field('typeName', inline(T.Token, tok(prop.typeName))),
        field('variability', inline(T.Variability, prop.uniform ? 1 : 0)),
      ];
      if (prop.connect !== undefined) afs.push(field('connectionPaths', explicitPathListOp([prop.connect])));
      else if (prop.samples) afs.push(field('timeSamples', timeSamples(prop.typeName, prop.samples.times, prop.samples.values)));
      else if (prop.value !== undefined) afs.push(field('default', value(prop.typeName, prop.value)));
      if (prop.elementSize !== undefined) afs.push(field('elementSize', inline(T.Int, prop.elementSize)));
      if (prop.interpolation) afs.push(field('interpolation', inline(T.Token, tok(prop.interpolation))));
      specs.push({ path: pnode.index, fieldSet: fieldSet(afs), type: SPEC_ATTRIBUTE });
    }
    for (const child of prim.children) visit(child, node);
  };
  for (const prim of layer.prims) visit(prim, root);

  // --- Structural sections ----------------------------------------------------
  const toc: Array<{ name: string; start: number; size: number }> = [];
  const section = (name: string, body: () => void) => {
    const start = out.length;
    body();
    toc.push({ name, start, size: out.length - start });
  };
  const compressedBlock = (bytes: Uint8Array) => { const c = tfCompress(bytes); out.u64(c.length); out.raw(c); };
  const compressedInts = (ints: number[]) => compressedBlock(compressInts(ints));

  section('TOKENS', () => {
    const bytes = enc.encode(tokens.join('\0') + '\0');
    const c = tfCompress(bytes);
    out.u64(tokens.length);
    out.u64(bytes.length);
    out.u64(c.length);
    out.raw(c);
  });
  section('STRINGS', () => {
    out.u64(strings.length);
    for (const i of strings) out.u32(i);
  });
  section('FIELDS', () => {
    out.u64(fields.length);
    compressedInts(fields.map((f) => f.token));
    const reps = new Uint8Array(fields.length * 8);
    const dv = new DataView(reps.buffer);
    fields.forEach((f, i) => dv.setBigUint64(i * 8, f.rep, true));
    compressedBlock(reps);
  });
  section('FIELDSETS', () => {
    out.u64(fieldSets.length);
    compressedInts(fieldSets.map((i) => (i === 0xffffffff ? -1 : i)));
  });
  section('PATHS', () => {
    // Pre-order flattening; each entry's jump says where its sibling is.
    const pathIndexes: number[] = [], elementTokens: number[] = [], jumps: number[] = [];
    const flatten = (nodes: PathNode[]) => {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const hasChild = n.children.length > 0;
        const hasSibling = i < nodes.length - 1;
        const at = pathIndexes.length;
        pathIndexes.push(n.index);
        elementTokens.push(n.isProp ? -n.token : n.token);
        jumps.push(0); // patched below when both child and sibling exist
        if (hasChild) flatten(n.children);
        jumps[at] = hasChild && hasSibling ? pathIndexes.length - at : hasChild ? -1 : hasSibling ? 0 : -2;
      }
    };
    flatten([root]);
    out.u64(paths.length);
    out.u64(pathIndexes.length);
    compressedInts(pathIndexes);
    compressedInts(elementTokens);
    compressedInts(jumps);
  });
  section('SPECS', () => {
    out.u64(specs.length);
    compressedInts(specs.map((s) => s.path));
    compressedInts(specs.map((s) => s.fieldSet));
    compressedInts(specs.map((s) => s.type));
  });

  // --- Table of contents + bootstrap ----------------------------------------
  const tocOffset = out.length;
  out.u64(toc.length);
  for (const s of toc) {
    const name = new Uint8Array(16); name.set(enc.encode(s.name).subarray(0, 15));
    out.raw(name); out.u64(s.start); out.u64(s.size);
  }
  const file = out.done();
  file.set(enc.encode('PXR-USDC'), 0);
  file[8] = 0; file[9] = 8; file[10] = 0; // crate version 0.8.0
  new DataView(file.buffer).setBigUint64(16, BigInt(tocOffset), true);
  return file;
}

/**
 * A literal-only LZ4 block: one sequence carrying every byte as a literal.
 * Valid per the LZ4 block format (the final sequence has no match), so any
 * LZ4 decoder accepts it; it just does not shrink anything.
 */
export function lz4LiteralBlock(bytes: Uint8Array): Uint8Array {
  const n = bytes.length;
  const head: number[] = [];
  if (n < 15) head.push(n << 4);
  else {
    head.push(0xf0);
    let rest = n - 15;
    while (rest >= 255) { head.push(255); rest -= 255; }
    head.push(rest);
  }
  const outBytes = new Uint8Array(head.length + n);
  outBytes.set(head, 0); outBytes.set(bytes, head.length);
  return outBytes;
}

/** TfFastCompression framing: a chunk-count byte (0 = single block) then the LZ4 block. */
export function tfCompress(bytes: Uint8Array): Uint8Array {
  const block = lz4LiteralBlock(bytes);
  const outBytes = new Uint8Array(block.length + 1);
  outBytes[0] = 0; outBytes.set(block, 1);
  return outBytes;
}

/**
 * Usd_IntegerCompression (32-bit): delta-code each value against the
 * previous one; the most common delta costs 0 bytes (code 0), others cost
 * 1/2/4 bytes (codes 1/2/3). Layout: int32 commonValue · 2-bit codes packed
 * four per byte, low bits first · the non-common deltas in order.
 */
export function compressInts(values: number[]): Uint8Array {
  const n = values.length;
  const deltas = new Int32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) { deltas[i] = (values[i] - prev) | 0; prev = values[i] | 0; }
  const freq = new Map<number, number>();
  for (const d of deltas) freq.set(d, (freq.get(d) ?? 0) + 1);
  let common = 0, best = -1;
  for (const [d, c] of freq) if (c > best || (c === best && d < common)) { best = c; common = d; }
  const codesLen = (n * 2 + 7) >> 3;
  const data: number[] = [];
  const codes = new Uint8Array(codesLen);
  for (let i = 0; i < n; i++) {
    const d = deltas[i];
    let code: number;
    if (d === common) code = 0;
    else if (d >= -128 && d <= 127) { code = 1; data.push(d & 0xff); }
    else if (d >= -32768 && d <= 32767) { code = 2; data.push(d & 0xff, (d >> 8) & 0xff); }
    else { code = 3; data.push(d & 0xff, (d >> 8) & 0xff, (d >> 16) & 0xff, (d >>> 24) & 0xff); }
    codes[i >> 2] |= code << ((i & 3) * 2);
  }
  const outBytes = new Uint8Array(4 + codesLen + data.length);
  new DataView(outBytes.buffer).setInt32(0, common, true);
  outBytes.set(codes, 4);
  outBytes.set(data, 4 + codesLen);
  return outBytes;
}
