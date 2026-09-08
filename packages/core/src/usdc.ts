/**
 * Binary USD ("crate", .usdc) writer for the subset of USD that GLBForge
 * emits. Targets crate file version 0.3.0 — the last fully uncompressed
 * layout (tokens, structural sections, and arrays all stored raw), which
 * every USD reader since 2016 (Pixar, Apple RealityKit / AR Quick Look,
 * Blender, three.js' USD loaders) accepts. Byte layout was verified
 * section-by-section against files written by Pixar's own crate writer with
 * USD_WRITE_NEW_USDC_FILES_AS_VERSION=0.3.0. Deterministic: same layer, same
 * bytes.
 *
 * File layout: bootstrap (88 bytes) · values · TOKENS · STRINGS · FIELDS ·
 * FIELDSETS · PATHS · SPECS · table of contents.
 */
import { vectorWidth, type UsdLayer, type UsdPrim, type UsdValue } from './usd-ir.js';

// Crate value types (crateDataTypes.h order).
const T = {
  Bool: 1, Int: 3, Float: 8, Double: 9, String: 10, Token: 11, AssetPath: 12, Matrix4d: 15,
  Vec2f: 20, Vec3f: 24, Vec4f: 28, TokenListOp: 32, PathListOp: 34, TokenVector: 41,
  Specifier: 42, Variability: 44,
} as const;
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
  u32(v: number) { this.ensure(4); new DataView(this.bytes.buffer).setUint32(this.length, v >>> 0, true); this.length += 4; }
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
        out.u32(1); out.u32(items.length);
        for (const s of items) out.u32(tok(s));
        return rep(base === 'token' ? T.Token : base === 'asset' ? T.AssetPath : T.String, at, IS_ARRAY);
      }
      const xs = v as ArrayLike<number>;
      if (base === 'int') {
        out.u32(1); out.u32(xs.length);
        for (let i = 0; i < xs.length; i++) out.i32(xs[i]);
        return rep(T.Int, at, IS_ARRAY);
      }
      if (base === 'float' || width === 0) {
        out.u32(1); out.u32(xs.length);
        for (let i = 0; i < xs.length; i++) out.f32(xs[i]);
        return rep(T.Float, at, IS_ARRAY);
      }
      const count = Math.floor(xs.length / width);
      out.u32(1); out.u32(count);
      for (let i = 0; i < count * width; i++) out.f32(xs[i]);
      return rep(width === 2 ? T.Vec2f : width === 3 ? T.Vec3f : T.Vec4f, at, IS_ARRAY);
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
        return rep(width === 2 ? T.Vec2f : width === 3 ? T.Vec3f : T.Vec4f, at);
      }
    }
  };

  // --- Specs ------------------------------------------------------------------
  const rootFields = [
    field('defaultPrim', inline(T.Token, tok(layer.defaultPrim))),
    field('metersPerUnit', value('double', layer.metersPerUnit)),
    field('upAxis', inline(T.Token, tok(layer.upAxis))),
  ];
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
      else if (prop.value !== undefined) afs.push(field('default', value(prop.typeName, prop.value)));
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

  section('TOKENS', () => {
    const bytes = enc.encode(tokens.join('\0') + '\0');
    out.u64(tokens.length);
    out.u64(bytes.length);
    out.raw(bytes);
  });
  section('STRINGS', () => {
    out.u64(strings.length);
    for (const s of strings) out.u32(s);
  });
  section('FIELDS', () => {
    out.u64(fields.length);
    for (const fld of fields) { out.u32(0xffffffff); out.u32(fld.token); out.u64(fld.rep); }
  });
  section('FIELDSETS', () => {
    out.u64(fieldSets.length);
    for (const i of fieldSets) out.u32(i);
  });
  section('PATHS', () => {
    out.u64(paths.length);
    const writeSiblings = (nodes: PathNode[]) => {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const hasChild = n.children.length > 0;
        const hasSibling = i < nodes.length - 1;
        out.u32(n.index); out.u32(n.token);
        out.u8((hasChild ? HAS_CHILD : 0) | (hasSibling ? HAS_SIBLING : 0) | (n.isProp ? IS_PRIM_PROPERTY : 0));
        out.u8(0); out.u8(0); out.u8(0);
        if (hasChild) {
          if (hasSibling) {
            const patchAt = out.length; out.u64(0);
            writeSiblings(n.children);
            out.patchU64(patchAt, out.length);
          } else {
            writeSiblings(n.children);
          }
        }
      }
    };
    writeSiblings([root]);
  });
  section('SPECS', () => {
    out.u64(specs.length);
    for (const s of specs) { out.u32(s.path); out.u32(s.fieldSet); out.u32(s.type); }
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
  file[8] = 0; file[9] = 3; file[10] = 0; // crate version 0.3.0
  new DataView(file.buffer).setBigUint64(16, BigInt(tocOffset), true);
  return file;
}
