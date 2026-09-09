/**
 * Binary USD (crate, .usdc) reader for a single layer. Handles crate
 * versions 0.4.0–0.10.x as written by Pixar's writer and by GLBForge's
 * usdc.ts: compressed structural sections (TOKENS / FIELDS / FIELDSETS /
 * PATHS / SPECS), compressed int/float arrays, time samples, list ops,
 * references/payloads and dictionaries. Values the reader does not
 * understand come back as null and are listed in `warnings` rather than
 * aborting the read.
 */
import { decompressInts32, decompressInts64, fromHalf, intCompressedBound, tfDecompress } from './compression.js';
import type { UsdLayerData, UsdListOp, UsdPrimNode, UsdProp, UsdReference, UsdTimeSamplesData, UsdVal } from './types.js';
import { listOpItems, parentPath } from './types.js';

const T = {
  Invalid: 0, Bool: 1, UChar: 2, Int: 3, UInt: 4, Int64: 5, UInt64: 6, Half: 7, Float: 8, Double: 9, String: 10, Token: 11, AssetPath: 12,
  Matrix2d: 13, Matrix3d: 14, Matrix4d: 15, Quatd: 16, Quatf: 17, Quath: 18, Vec2d: 19, Vec2f: 20, Vec2h: 21, Vec2i: 22, Vec3d: 23, Vec3f: 24,
  Vec3h: 25, Vec3i: 26, Vec4d: 27, Vec4f: 28, Vec4h: 29, Vec4i: 30, Dictionary: 31, TokenListOp: 32, StringListOp: 33, PathListOp: 34,
  ReferenceListOp: 35, IntListOp: 36, Int64ListOp: 37, UIntListOp: 38, UInt64ListOp: 39, PathVector: 40, TokenVector: 41, Specifier: 42,
  Permission: 43, Variability: 44, VariantSelectionMap: 45, TimeSamples: 46, Payload: 47, DoubleVector: 48, LayerOffsetVector: 49,
  StringVector: 50, ValueBlock: 51, Value: 52, UnregisteredValue: 53, UnregisteredValueListOp: 54, PayloadListOp: 55, TimeCode: 56,
  PathExpression: 57,
} as const;

const SPEC_ATTRIBUTE = 1, SPEC_PRIM = 6, SPEC_PSEUDO_ROOT = 7, SPEC_RELATIONSHIP = 8;

interface Section { name: string; start: number; size: number }

export function readUsdc(bytes: Uint8Array): UsdLayerData {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const warnings: string[] = [];
  if (dec.decode(bytes.subarray(0, 8)) !== 'PXR-USDC') throw new Error('Not a crate file (missing PXR-USDC magic).');
  const major = bytes[8], minor = bytes[9], patch = bytes[10];
  const version = `${major}.${minor}.${patch}`;
  const vnum = major * 10000 + minor * 100 + patch;
  if (vnum < 400) throw new Error(`Crate version ${version} predates compressed sections; not supported.`);
  const u64 = (p: number) => Number(dv.getBigUint64(p, true));
  const i64 = (p: number) => Number(dv.getBigInt64(p, true));
  const arrayCount = (p: number): [number, number] => (vnum >= 700 ? [u64(p), p + 8] : [dv.getUint32(p + 4, true), p + 8]);

  // --- table of contents ---
  const tocOffset = u64(16);
  const nSections = u64(tocOffset);
  const sections = new Map<string, Section>();
  for (let i = 0; i < nSections; i++) {
    const at = tocOffset + 8 + i * 32;
    const name = dec.decode(bytes.subarray(at, at + 16)).replace(/\0.*$/, '');
    sections.set(name, { name, start: u64(at + 16), size: u64(at + 24) });
  }
  const need = (name: string): Section => { const s = sections.get(name); if (!s) throw new Error(`Crate file has no ${name} section.`); return s; };

  const readCompressedInts = (p: number, n: number, wide = false): [Int32Array | Float64Array, number] => {
    const compSize = u64(p);
    const raw = tfDecompress(bytes.subarray(p + 8, p + 8 + compSize), intCompressedBound(n, wide));
    return [wide ? decompressInts64(raw, n) : decompressInts32(raw, n), p + 8 + compSize];
  };

  // --- TOKENS ---
  const tokens: string[] = [];
  {
    const s = need('TOKENS');
    const n = u64(s.start), rawSize = u64(s.start + 8), compSize = u64(s.start + 16);
    const raw = tfDecompress(bytes.subarray(s.start + 24, s.start + 24 + compSize), rawSize);
    let start = 0;
    for (let i = 0; i < raw.length && tokens.length < n; i++) {
      if (raw[i] === 0) { tokens.push(dec.decode(raw.subarray(start, i))); start = i + 1; }
    }
    while (tokens.length < n) tokens.push('');
  }
  // --- STRINGS ---
  const strings: number[] = [];
  {
    const s = need('STRINGS');
    const n = u64(s.start);
    for (let i = 0; i < n; i++) strings.push(dv.getUint32(s.start + 8 + i * 4, true));
  }
  const str = (i: number) => tokens[strings[i]] ?? '';
  // --- FIELDS ---
  const fields: Array<{ name: string; rep: bigint }> = [];
  {
    const s = need('FIELDS');
    const n = u64(s.start);
    const [tokIdx, next] = readCompressedInts(s.start + 8, n);
    const compSize = u64(next);
    const reps = tfDecompress(bytes.subarray(next + 8, next + 8 + compSize), n * 8);
    const rdv = new DataView(reps.buffer, reps.byteOffset, reps.byteLength);
    for (let i = 0; i < n; i++) fields.push({ name: tokens[tokIdx[i]] ?? '', rep: rdv.getBigUint64(i * 8, true) });
  }
  // --- FIELDSETS ---
  let fieldSets: Int32Array | Float64Array;
  {
    const s = need('FIELDSETS');
    const n = u64(s.start);
    [fieldSets] = readCompressedInts(s.start + 8, n);
  }
  // --- PATHS ---
  const paths: string[] = [];
  {
    const s = need('PATHS');
    const numPaths = u64(s.start);
    const n = u64(s.start + 8);
    let p = s.start + 16;
    let pathIndexes: Int32Array | Float64Array, elementTokens: Int32Array | Float64Array, jumps: Int32Array | Float64Array;
    [pathIndexes, p] = readCompressedInts(p, n);
    [elementTokens, p] = readCompressedInts(p, n);
    [jumps] = readCompressedInts(p, n);
    paths.length = numPaths;
    const build = (start: number, parent: string) => {
      let cur = start;
      let hasChild: boolean, hasSibling: boolean;
      do {
        const thisIndex = cur++;
        let thisPath: string;
        if (parent === '') { parent = '/'; thisPath = '/'; }
        else {
          const ti = elementTokens[thisIndex];
          const tok = tokens[Math.abs(ti)] ?? '';
          thisPath = ti < 0 ? `${parent === '/' ? '/' : parent}.${tok}` : parent === '/' ? `/${tok}` : `${parent}/${tok}`;
        }
        paths[pathIndexes[thisIndex]] = thisPath;
        const j = jumps[thisIndex];
        hasChild = j > 0 || j === -1;
        hasSibling = j >= 0;
        if (hasChild) {
          if (hasSibling) build(thisIndex + j, parent);
          parent = thisPath;
        }
      } while (hasChild || hasSibling);
    };
    if (n > 0) build(0, '');
  }
  // --- SPECS ---
  const specs: Array<{ path: string; fieldSet: number; type: number }> = [];
  {
    const s = need('SPECS');
    const n = u64(s.start);
    let p = s.start + 8;
    let pathIdx: Int32Array | Float64Array, fsIdx: Int32Array | Float64Array, types: Int32Array | Float64Array;
    [pathIdx, p] = readCompressedInts(p, n);
    [fsIdx, p] = readCompressedInts(p, n);
    [types] = readCompressedInts(p, n);
    for (let i = 0; i < n; i++) specs.push({ path: paths[pathIdx[i]] ?? '', fieldSet: fsIdx[i], type: types[i] });
  }

  // --- value unpacking ---
  const IS_ARRAY = 1n << 63n, IS_INLINED = 1n << 62n, IS_COMPRESSED = 1n << 61n;
  const typeOf = (rep: bigint) => Number((rep >> 48n) & 0xffn);
  const payloadOf = (rep: bigint) => Number(rep & ((1n << 48n) - 1n));
  const f32 = (bits: number) => { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, bits >>> 0, true); return b.getFloat32(0, true); };

  const readVecArray = (p: number, count: number, width: number, kind: 'f' | 'd' | 'h' | 'i'): [Float32Array | Float64Array | Int32Array, number] => {
    const n = count * width;
    if (kind === 'f') { const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = dv.getFloat32(p + i * 4, true); return [out, p + n * 4]; }
    if (kind === 'd') { const out = new Float64Array(n); for (let i = 0; i < n; i++) out[i] = dv.getFloat64(p + i * 8, true); return [out, p + n * 8]; }
    if (kind === 'h') { const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = fromHalf(dv.getUint16(p + i * 2, true)); return [out, p + n * 2]; }
    const out = new Int32Array(n); for (let i = 0; i < n; i++) out[i] = dv.getInt32(p + i * 4, true); return [out, p + n * 4];
  };
  const VEC: Record<number, [number, 'f' | 'd' | 'h' | 'i']> = {
    [T.Vec2f]: [2, 'f'], [T.Vec3f]: [3, 'f'], [T.Vec4f]: [4, 'f'], [T.Quatf]: [4, 'f'],
    [T.Vec2d]: [2, 'd'], [T.Vec3d]: [3, 'd'], [T.Vec4d]: [4, 'd'], [T.Quatd]: [4, 'd'],
    [T.Vec2h]: [2, 'h'], [T.Vec3h]: [3, 'h'], [T.Vec4h]: [4, 'h'], [T.Quath]: [4, 'h'],
    [T.Vec2i]: [2, 'i'], [T.Vec3i]: [3, 'i'], [T.Vec4i]: [4, 'i'],
    [T.Matrix2d]: [4, 'd'], [T.Matrix3d]: [9, 'd'], [T.Matrix4d]: [16, 'd'],
  };

  const readListOp = (p: number, item: (q: number) => [UsdVal, number]): UsdListOp => {
    const bits = bytes[p]; p += 1;
    const op: UsdListOp = {};
    if (bits & 1) op.isExplicit = true;
    const list = (): UsdVal[] => {
      const n = u64(p); p += 8;
      const out: UsdVal[] = [];
      for (let i = 0; i < n; i++) { const [v, q] = item(p); out.push(v); p = q; }
      return out;
    };
    if (bits & 2) op.explicit = list();
    if (bits & 4) op.added = list();
    if (bits & 32) op.prepended = list();
    if (bits & 64) op.appended = list();
    if (bits & 8) op.deleted = list();
    if (bits & 16) op.ordered = list();
    return op;
  };
  const tokenItem = (q: number): [string, number] => [tokens[dv.getUint32(q, true)] ?? '', q + 4];
  const pathItem = (q: number): [string, number] => [paths[dv.getUint32(q, true)] ?? '', q + 4];
  const stringItem = (q: number): [string, number] => [str(dv.getUint32(q, true)), q + 4];
  const intItem = (q: number): [number, number] => [dv.getInt32(q, true), q + 4];
  const int64Item = (q: number): [number, number] => [i64(q), q + 8];
  const referenceItem = (q: number): [UsdReference, number] => {
    const assetPath = str(dv.getUint32(q, true)); q += 4;
    const primPath = paths[dv.getUint32(q, true)] ?? ''; q += 4;
    const offset = dv.getFloat64(q, true), scale = dv.getFloat64(q + 8, true); q += 16;
    const [, next] = readDictionary(q);
    return [{ assetPath, primPath, offset, scale }, next];
  };
  const payloadItem = (q: number): [UsdReference, number] => {
    const assetPath = str(dv.getUint32(q, true)); q += 4;
    const primPath = paths[dv.getUint32(q, true)] ?? ''; q += 4;
    if (vnum >= 800) { const offset = dv.getFloat64(q, true), scale = dv.getFloat64(q + 8, true); return [{ assetPath, primPath, offset, scale }, q + 16]; }
    return [{ assetPath, primPath }, q];
  };
  const readDictionary = (p: number): [Record<string, UsdVal>, number] => {
    const out: Record<string, UsdVal> = {};
    const n = u64(p); p += 8;
    for (let i = 0; i < n; i++) {
      const key = str(dv.getUint32(p, true)); p += 4;
      const size = i64(p); p += 8;
      // The value's rep is the last 8 bytes of the `size` bytes that follow (its payload precedes it).
      const repAt = p + size - 8;
      try { out[key] = repAt >= p ? unpack(dv.getBigUint64(repAt, true)) : null; } catch { out[key] = null; }
      p += size;
    }
    return [out, p];
  };

  const unpack = (rep: bigint): UsdVal => {
    const type = typeOf(rep);
    const payload = payloadOf(rep);
    const inlined = (rep & IS_INLINED) !== 0n;
    const isArray = (rep & IS_ARRAY) !== 0n;
    const compressed = (rep & IS_COMPRESSED) !== 0n;
    if (type === T.ValueBlock) return null;
    if (isArray) {
      let [count, p] = arrayCount(payload);
      if (count === 0) return type === T.Token || type === T.String || type === T.AssetPath ? [] : new Float32Array(0);
      if (compressed) {
        if (type === T.Int || type === T.UInt) return readCompressedInts(p, count)[0];
        if (type === T.Int64 || type === T.UInt64) return readCompressedInts(p, count, true)[0];
        if (type === T.Float || type === T.Double || type === T.Half) {
          const code = String.fromCharCode(bytes[p]); p += 1;
          const out = new (type === T.Double ? Float64Array : Float32Array)(count);
          if (code === 'i') { const [ints] = readCompressedInts(p, count); for (let i = 0; i < count; i++) out[i] = ints[i]; return out; }
          if (code === 't') {
            const lutSize = dv.getUint32(p, true); p += 4;
            const lut = new Float64Array(lutSize);
            for (let i = 0; i < lutSize; i++) {
              lut[i] = type === T.Double ? dv.getFloat64(p + i * 8, true) : type === T.Half ? fromHalf(dv.getUint16(p + i * 2, true)) : dv.getFloat32(p + i * 4, true);
            }
            p += lutSize * (type === T.Double ? 8 : type === T.Half ? 2 : 4);
            const [idx] = readCompressedInts(p, count);
            for (let i = 0; i < count; i++) out[i] = lut[idx[i]];
            return out;
          }
          warnings.push(`usdc: unknown float compression code "${code}"`);
          return null;
        }
        warnings.push(`usdc: compressed array of type ${type} not supported`);
        return null;
      }
      switch (type) {
        case T.Bool: case T.UChar: return Uint8Array.from(bytes.subarray(p, p + count));
        case T.Int: return readVecArray(p, count, 1, 'i')[0];
        case T.UInt: { const out = new Uint32Array(count); for (let i = 0; i < count; i++) out[i] = dv.getUint32(p + i * 4, true); return out; }
        case T.Int64: case T.UInt64: { const out = new Float64Array(count); for (let i = 0; i < count; i++) out[i] = i64(p + i * 8); return out; }
        case T.Half: return readVecArray(p, count, 1, 'h')[0];
        case T.Float: return readVecArray(p, count, 1, 'f')[0];
        case T.Double: case T.TimeCode: return readVecArray(p, count, 1, 'd')[0];
        case T.Token: case T.AssetPath: { const out: string[] = []; for (let i = 0; i < count; i++) out.push(tokens[dv.getUint32(p + i * 4, true)] ?? ''); return out; }
        case T.String: { const out: string[] = []; for (let i = 0; i < count; i++) out.push(str(dv.getUint32(p + i * 4, true))); return out; }
        default: {
          const v = VEC[type];
          if (v) return readVecArray(p, count, v[0], v[1])[0];
          warnings.push(`usdc: array type ${type} not supported`);
          return null;
        }
      }
    }
    if (inlined) {
      switch (type) {
        case T.Bool: return payload !== 0;
        case T.Int: return payload | 0;
        case T.UInt: return payload >>> 0;
        case T.Float: return f32(payload);
        case T.Double: return f32(payload);
        case T.Token: case T.AssetPath: return tokens[payload] ?? '';
        case T.String: return str(payload);
        case T.Specifier: return ['def', 'over', 'class'][payload] ?? 'def';
        case T.Variability: return payload === 1 ? 'uniform' : 'varying';
        case T.Permission: return payload === 0 ? 'public' : 'private';
        case T.Int64: case T.UInt64: return payload;
        case T.Half: return fromHalf(payload & 0xffff);
        case T.Vec2i: case T.Vec3i: case T.Vec4i: case T.Vec2f: case T.Vec3f: case T.Vec4f: case T.Vec2d: case T.Vec3d: case T.Vec4d: case T.Vec2h: case T.Vec3h: case T.Vec4h: {
          const w = VEC[type][0];
          const out: number[] = [];
          for (let i = 0; i < w; i++) out.push((payload >> (i * 8)) << 24 >> 24);
          return out;
        }
        case T.Matrix2d: case T.Matrix3d: case T.Matrix4d: {
          const d = type === T.Matrix2d ? 2 : type === T.Matrix3d ? 3 : 4;
          const out = new Array<number>(d * d).fill(0);
          for (let i = 0; i < d; i++) out[i * d + i] = (payload >> (i * 8)) << 24 >> 24;
          return out;
        }
        case T.ValueBlock: return null;
        default: return null;
      }
    }
    // Out-of-line scalar at `payload`.
    const p = payload;
    switch (type) {
      case T.Double: case T.TimeCode: return dv.getFloat64(p, true);
      case T.Int64: case T.UInt64: return i64(p);
      case T.Float: return dv.getFloat32(p, true);
      case T.Half: return fromHalf(dv.getUint16(p, true));
      case T.String: return str(dv.getUint32(p, true));
      case T.Token: case T.AssetPath: return tokens[dv.getUint32(p, true)] ?? '';
      case T.TokenVector: { const n = u64(p); const out: string[] = []; for (let i = 0; i < n; i++) out.push(tokens[dv.getUint32(p + 8 + i * 4, true)] ?? ''); return out; }
      case T.StringVector: { const n = u64(p); const out: string[] = []; for (let i = 0; i < n; i++) out.push(str(dv.getUint32(p + 8 + i * 4, true))); return out; }
      case T.PathVector: { const n = u64(p); const out: string[] = []; for (let i = 0; i < n; i++) out.push(paths[dv.getUint32(p + 8 + i * 4, true)] ?? ''); return out; }
      case T.DoubleVector: { const n = u64(p); const out = new Float64Array(n); for (let i = 0; i < n; i++) out[i] = dv.getFloat64(p + 8 + i * 8, true); return out; }
      case T.TokenListOp: return readListOp(p, tokenItem);
      case T.StringListOp: return readListOp(p, stringItem);
      case T.PathListOp: return readListOp(p, pathItem);
      case T.IntListOp: case T.UIntListOp: return readListOp(p, intItem);
      case T.Int64ListOp: case T.UInt64ListOp: return readListOp(p, int64Item);
      case T.ReferenceListOp: return readListOp(p, referenceItem);
      case T.PayloadListOp: return readListOp(p, payloadItem);
      case T.Payload: return payloadItem(p)[0];
      case T.Dictionary: return readDictionary(p)[0];
      case T.VariantSelectionMap: {
        const n = u64(p); let q = p + 8; const out: Record<string, string> = {};
        for (let i = 0; i < n; i++) { const k = str(dv.getUint32(q, true)); const v = str(dv.getUint32(q + 4, true)); q += 8; out[k] = v; }
        return out;
      }
      case T.TimeSamples: {
        const off = i64(p);
        const timesRep = dv.getBigUint64(p + off, true);
        const times = unpack(timesRep);
        let q = p + off + 8;
        const off2 = i64(q); q += off2;
        const n = u64(q); q += 8;
        const values: UsdVal[] = [];
        for (let i = 0; i < n; i++) { values.push(unpack(dv.getBigUint64(q, true))); q += 8; }
        const ts: UsdTimeSamplesData = { times: Array.from((times as Float64Array | number[]) ?? []), values };
        return ts;
      }
      case T.LayerOffsetVector: { const n = u64(p); const out: Array<{ offset: number; scale: number }> = []; for (let i = 0; i < n; i++) out.push({ offset: dv.getFloat64(p + 8 + i * 16, true), scale: dv.getFloat64(p + 16 + i * 16, true) }); return out; }
      default: {
        const v = VEC[type];
        if (v) return Array.from(readVecArray(p, 1, v[0], v[1])[0]);
        warnings.push(`usdc: value type ${type} not supported`);
        return null;
      }
    }
  };

  const fieldsOf = (fieldSet: number): Record<string, UsdVal> => {
    const out: Record<string, UsdVal> = {};
    for (let i = fieldSet; i < fieldSets.length && fieldSets[i] !== -1; i++) {
      const f = fields[fieldSets[i]];
      if (!f) continue;
      try { out[f.name] = unpack(f.rep); } catch (err) { warnings.push(`usdc: field ${f.name}: ${err instanceof Error ? err.message : String(err)}`); out[f.name] = null; }
    }
    return out;
  };

  // --- assemble prims ---
  const layerMeta: Record<string, UsdVal> = {};
  const primByPath = new Map<string, UsdPrimNode>();
  const propSpecs: Array<{ path: string; type: number; fields: Record<string, UsdVal> }> = [];
  let primCount = 0;
  for (const s of specs) {
    if (s.type === SPEC_PSEUDO_ROOT) { Object.assign(layerMeta, fieldsOf(s.fieldSet)); continue; }
    if (s.path.includes('{')) continue; // variant content: not composed
    if (s.type === SPEC_PRIM) {
      const f = fieldsOf(s.fieldSet);
      const name = s.path.slice(s.path.lastIndexOf('/') + 1);
      const arcs: string[] = [];
      for (const key of ['references', 'payload', 'inheritPaths', 'specializes', 'variantSetNames', 'clips'] as const) {
        if (f[key] === undefined || f[key] === null) continue;
        const items = listOpItems(f[key]);
        const desc = items.map((it) => (it && typeof it === 'object' && 'assetPath' in (it as object) ? `${(it as UsdReference).assetPath || '(self)'}${(it as UsdReference).primPath ? `<${(it as UsdReference).primPath}>` : ''}` : String(it)));
        arcs.push(`${key}: ${desc.join(', ') || '(set)'}`);
      }
      const prim: UsdPrimNode = {
        path: s.path, name, specifier: (f.specifier as UsdPrimNode['specifier']) ?? 'def',
        typeName: typeof f.typeName === 'string' && f.typeName ? f.typeName : null,
        meta: f, apiSchemas: listOpItems<string>(f.apiSchemas), arcs, properties: [], children: [],
      };
      primByPath.set(s.path, prim);
      primCount++;
      continue;
    }
    if (s.type === SPEC_ATTRIBUTE || s.type === SPEC_RELATIONSHIP) propSpecs.push({ path: s.path, type: s.type, fields: fieldsOf(s.fieldSet) });
  }
  for (const ps of propSpecs) {
    const dot = ps.path.lastIndexOf('.');
    const primPath = ps.path.slice(0, dot), name = ps.path.slice(dot + 1);
    const prim = primByPath.get(primPath);
    if (!prim) continue;
    const f = ps.fields;
    const prop: UsdProp = {
      name, kind: ps.type === SPEC_RELATIONSHIP ? 'relationship' : 'attribute',
      typeName: typeof f.typeName === 'string' ? f.typeName : null,
      variability: f.variability === 'uniform' ? 'uniform' : 'varying',
      custom: f.custom === true,
      meta: f,
    };
    if (f.default !== undefined) prop.value = f.default;
    if (f.timeSamples && typeof f.timeSamples === 'object' && 'times' in (f.timeSamples as object)) prop.timeSamples = f.timeSamples as UsdTimeSamplesData;
    if (f.connectionPaths !== undefined) prop.connections = listOpItems<string>(f.connectionPaths);
    if (f.targetPaths !== undefined) prop.targets = listOpItems<string>(f.targetPaths);
    prim.properties.push(prop);
  }
  // Order properties as declared when the prim lists them.
  for (const prim of primByPath.values()) {
    const order = Array.isArray(prim.meta.properties) ? (prim.meta.properties as string[]) : null;
    if (order) prim.properties.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }
  const roots: UsdPrimNode[] = [];
  for (const prim of primByPath.values()) {
    const parent = parentPath(prim.path);
    const parentPrim = parent === '/' ? null : primByPath.get(parent);
    if (parentPrim) parentPrim.children.push(prim); else roots.push(prim);
  }
  const orderChildren = (list: UsdPrimNode[], order: UsdVal) => {
    if (Array.isArray(order)) list.sort((a, b) => (order as string[]).indexOf(a.name) - (order as string[]).indexOf(b.name));
  };
  orderChildren(roots, layerMeta.primChildren);
  for (const prim of primByPath.values()) orderChildren(prim.children, prim.meta.primChildren);

  return { format: 'usdc', crateVersion: version, meta: layerMeta, prims: roots, primCount, warnings };
}
