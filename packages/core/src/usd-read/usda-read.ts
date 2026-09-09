/**
 * Tolerant ASCII USD (.usda) parser for a single layer: layer metadata,
 * prim hierarchy with specifier/type/metadata (apiSchemas, references,
 * payload, variants…), attributes with defaults / connections / time
 * samples / metadata, relationships. Unknown constructs are skipped by
 * bracket balancing and noted in `warnings`.
 */
import type { UsdLayerData, UsdPrimNode, UsdProp, UsdReference, UsdVal } from './types.js';

type Tok = { t: 'id' | 'num' | 'str' | 'asset' | 'path' | 'punct'; v: string; line: number };

const PUNCT = new Set(['(', ')', '[', ']', '{', '}', '=', ',', ':', '.', ';']);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const n = src.length;
  let i = 0, line = 1;
  const isIdStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
  const isIdChar = (c: number) => isIdStart(c) || (c >= 48 && c <= 57) || c === 58; // ':' namespaces
  const isDigit = (c: number) => c >= 48 && c <= 57;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 10) { line++; i++; continue; }
    if (c === 32 || c === 9 || c === 13) { i++; continue; }
    if (c === 35) { while (i < n && src.charCodeAt(i) !== 10) i++; continue; } // # comment
    if (c === 34) { // string
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        const body = src.slice(i + 3, end < 0 ? n : end);
        line += (body.match(/\n/g) ?? []).length;
        out.push({ t: 'str', v: body, line }); i = end < 0 ? n : end + 3; continue;
      }
      let j = i + 1, s = '';
      while (j < n && src.charCodeAt(j) !== 34) {
        if (src.charCodeAt(j) === 92 && j + 1 < n) { const e = src[j + 1]; s += e === 'n' ? '\n' : e === 't' ? '\t' : e; j += 2; continue; }
        s += src[j++];
      }
      out.push({ t: 'str', v: s, line }); i = j + 1; continue;
    }
    if (c === 64) { // @asset@ or @@@asset@@@
      const triple = src.startsWith('@@@', i);
      const close = triple ? '@@@' : '@';
      const end = src.indexOf(close, i + close.length);
      out.push({ t: 'asset', v: src.slice(i + close.length, end < 0 ? n : end), line }); i = end < 0 ? n : end + close.length; continue;
    }
    if (c === 60) { // <path>
      const end = src.indexOf('>', i + 1);
      out.push({ t: 'path', v: src.slice(i + 1, end < 0 ? n : end), line }); i = end < 0 ? n : end + 1; continue;
    }
    if (isDigit(c) || ((c === 45 || c === 43 || c === 46) && i + 1 < n && (isDigit(src.charCodeAt(i + 1)) || src.charCodeAt(i + 1) === 46))) {
      let j = i + 1;
      while (j < n) { const d = src.charCodeAt(j); if (isDigit(d) || d === 46 || d === 101 || d === 69 || ((d === 45 || d === 43) && (src.charCodeAt(j - 1) === 101 || src.charCodeAt(j - 1) === 69))) j++; else break; }
      out.push({ t: 'num', v: src.slice(i, j), line }); i = j; continue;
    }
    if ((c === 45 || c === 43) && src.startsWith('inf', i + 1)) { out.push({ t: 'num', v: src.slice(i, i + 4), line }); i += 4; continue; }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdChar(src.charCodeAt(j))) j++;
      out.push({ t: 'id', v: src.slice(i, j), line }); i = j; continue;
    }
    if (PUNCT.has(src[i])) { out.push({ t: 'punct', v: src[i], line }); i++; continue; }
    i++; // unknown char — skip
  }
  return out;
}

const LIST_OP_WORDS = new Set(['add', 'append', 'prepend', 'delete', 'reorder']);
const SPECIFIERS = new Set(['def', 'over', 'class']);

class Parser {
  private p = 0;
  readonly warnings: string[] = [];
  constructor(private toks: Tok[]) {}

  private peek(o = 0): Tok | undefined { return this.toks[this.p + o]; }
  private next(): Tok | undefined { return this.toks[this.p++]; }
  private is(v: string, o = 0): boolean { const t = this.peek(o); return !!t && t.t === 'punct' && t.v === v; }
  private isId(v: string, o = 0): boolean { const t = this.peek(o); return !!t && t.t === 'id' && t.v === v; }
  private expect(v: string): void { if (!this.is(v)) { const t = this.peek(); throw new Error(`usda: expected "${v}" at line ${t?.line ?? 'EOF'}, got ${t ? `"${t.v}"` : 'EOF'}`); } this.p++; }
  private warn(msg: string) { if (this.warnings.length < 50) this.warnings.push(msg); }

  /** Skip a balanced bracket group starting at the current opening token. */
  private skipGroup(): void {
    const open = this.next();
    if (!open) return;
    const close = open.v === '(' ? ')' : open.v === '[' ? ']' : '}';
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (!t) return;
      if (t.t !== 'punct') continue;
      if (t.v === open.v) depth++; else if (t.v === close) depth--;
    }
  }

  parseLayer(): UsdLayerData {
    const meta: Record<string, UsdVal> = {};
    if (this.is('(')) { this.p++; this.parseMetaBody(meta, ')'); }
    const prims: UsdPrimNode[] = [];
    let count = { n: 0 };
    while (this.peek()) {
      const t = this.peek()!;
      if (t.t === 'id' && SPECIFIERS.has(t.v)) prims.push(this.parsePrim('', count));
      else { this.p++; }
    }
    return { format: 'usda', meta, prims, primCount: count.n, warnings: this.warnings };
  }

  /** Parse `key = value` pairs (with optional list-op / type prefixes) until `close`. */
  private parseMetaBody(meta: Record<string, UsdVal>, close: string): Record<string, UsdVal> {
    while (this.peek() && !this.is(close)) {
      if (this.is(';')) { this.p++; continue; }
      let listOp: string | null = null;
      if (this.peek()!.t === 'id' && LIST_OP_WORDS.has(this.peek()!.v) && this.peek(1)?.t === 'id') { listOp = this.next()!.v; }
      // Optional type prefix inside dictionaries: `string note = "x"`, `dictionary d = {…}`, `float3[] xs = …`.
      let key = this.next();
      if (!key) break;
      if (key.t === 'str') { /* dictionary keys may be quoted */ }
      else if (key.t !== 'id') { this.warn(`usda: unexpected "${key.v}" in metadata at line ${key.line}`); continue; }
      if (this.is('[') && this.is(']', 1)) { this.p += 2; }
      if (this.peek()?.t === 'id' || this.peek()?.t === 'str') { key = this.next()!; } // typed entry: drop the type
      if (!this.is('=')) { meta[key.v] = true; continue; }
      this.p++;
      const value = this.parseValue();
      if (listOp) {
        const existing = (meta[key.v] && typeof meta[key.v] === 'object' && !Array.isArray(meta[key.v]) && !(meta[key.v] instanceof Float64Array)) ? (meta[key.v] as Record<string, UsdVal[]>) : {};
        const slot = listOp === 'add' ? 'added' : listOp === 'append' ? 'appended' : listOp === 'prepend' ? 'prepended' : listOp === 'delete' ? 'deleted' : 'ordered';
        existing[slot] = Array.isArray(value) ? (value as UsdVal[]) : [value];
        meta[key.v] = existing;
      } else {
        meta[key.v] = value;
      }
    }
    if (this.is(close)) this.p++;
    return meta;
  }

  private parseValue(): UsdVal {
    const t = this.next();
    if (!t) return null;
    if (t.t === 'num') return t.v === 'inf' || t.v === '+inf' ? Infinity : t.v === '-inf' ? -Infinity : Number(t.v);
    if (t.t === 'str') return t.v;
    if (t.t === 'path') return t.v;
    if (t.t === 'asset') {
      // reference/payload item: @asset@ [<primPath>] [(offset = …; scale = …)]
      const ref: UsdReference = { assetPath: t.v, primPath: '' };
      if (this.peek()?.t === 'path') ref.primPath = this.next()!.v;
      if (this.is('(')) { const m: Record<string, UsdVal> = {}; this.p++; this.parseMetaBody(m, ')'); if (typeof m.offset === 'number') ref.offset = m.offset; if (typeof m.scale === 'number') ref.scale = m.scale; }
      return ref;
    }
    if (t.t === 'id') {
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'None') return null;
      if (t.v === 'inf') return Infinity;
      if (t.v === 'nan') return NaN;
      return t.v; // bare token
    }
    if (t.t === 'punct') {
      if (t.v === '(') {
        const items: UsdVal[] = [];
        while (this.peek() && !this.is(')')) { items.push(this.parseValue()); if (this.is(',')) this.p++; }
        this.expect(')');
        return items;
      }
      if (t.v === '[') {
        const items: UsdVal[] = [];
        while (this.peek() && !this.is(']')) { items.push(this.parseValue()); if (this.is(',')) this.p++; }
        this.expect(']');
        return items;
      }
      if (t.v === '{') {
        // dictionary (or variants map)
        const dict: Record<string, UsdVal> = {};
        this.parseMetaBody(dict, '}');
        return dict;
      }
      if (t.v === '.') { // path-ish leftovers such as `.connect` on the value side — should not happen
        return this.parseValue();
      }
    }
    this.warn(`usda: unexpected value token "${t.v}" at line ${t.line}`);
    return null;
  }

  private parsePrim(parentPathStr: string, count: { n: number }): UsdPrimNode {
    const spec = this.next()!.v as UsdPrimNode['specifier'];
    let typeName: string | null = null;
    if (this.peek()?.t === 'id') typeName = this.next()!.v;
    const nameTok = this.next();
    if (!nameTok || nameTok.t !== 'str') throw new Error(`usda: expected prim name at line ${nameTok?.line ?? 'EOF'}`);
    const path = `${parentPathStr}/${nameTok.v}`;
    const prim: UsdPrimNode = { path, name: nameTok.v, specifier: spec, typeName, meta: {}, apiSchemas: [], arcs: [], properties: [], children: [] };
    count.n++;
    if (this.is('(')) { this.p++; this.parseMetaBody(prim.meta, ')'); }
    prim.apiSchemas = flattenListOp(prim.meta.apiSchemas).filter((x): x is string => typeof x === "string");
    for (const key of ['references', 'payload', 'inheritPaths', 'specializes', 'variantSets', 'clips', 'subLayers'] as const) {
      const v = prim.meta[key];
      if (v === undefined || v === null) continue;
      const items = flattenListOp(v);
      const arc = `${key === 'variantSets' ? 'variantSet' : key}: ${items.map((it) => (it && typeof it === 'object' && 'assetPath' in (it as object) ? `${(it as UsdReference).assetPath || '(self)'}${(it as UsdReference).primPath ? `<${(it as UsdReference).primPath}>` : ''}` : String(it))).join(', ') || '(set)'}`;
      if (!prim.arcs.includes(arc)) prim.arcs.push(arc);
    }
    this.expect('{');
    while (this.peek() && !this.is('}')) {
      const t = this.peek()!;
      if (t.t === 'id' && SPECIFIERS.has(t.v)) { prim.children.push(this.parsePrim(path, count)); continue; }
      if (t.t === 'id' && t.v === 'variantSet') {
        // variantSet "name" = { "variant" ( … ) { … } … } — content is not composed; skip but keep the arc.
        this.p++;
        const name = this.next();
        if (!prim.arcs.includes(`variantSet: ${name?.v ?? '?'}`)) prim.arcs.push(`variantSet: ${name?.v ?? '?'}`);
        if (this.is('=')) this.p++;
        if (this.is('{')) this.skipGroup();
        continue;
      }
      if (t.t === 'id') {
        const prop = this.parseProperty();
        if (prop) {
          const existing = prim.properties.find((x) => x.name === prop.name && x.kind === prop.kind);
          if (existing) {
            if (prop.value !== undefined) existing.value = prop.value;
            if (prop.timeSamples) existing.timeSamples = prop.timeSamples;
            if (prop.connections) existing.connections = prop.connections;
            if (prop.targets) existing.targets = prop.targets;
            Object.assign(existing.meta, prop.meta);
            if (prop.typeName && !existing.typeName) existing.typeName = prop.typeName;
          } else prim.properties.push(prop);
        }
        continue;
      }
      if (t.t === 'punct' && (t.v === '(' || t.v === '[' || t.v === '{')) { this.skipGroup(); continue; }
      this.p++;
    }
    this.expect('}');
    return prim;
  }

  private parseProperty(): UsdProp | null {
    let custom = false, uniform = false;
    while (this.peek()?.t === 'id' && (LIST_OP_WORDS.has(this.peek()!.v) || this.peek()!.v === 'custom' || this.peek()!.v === 'uniform' || this.peek()!.v === 'varying')) {
      const w = this.next()!.v;
      if (w === 'custom') custom = true; else if (w === 'uniform') uniform = true;
    }
    const first = this.next();
    if (!first || first.t !== 'id') return null;
    if (first.v === 'rel') {
      const name = this.next();
      if (!name) return null;
      const prop: UsdProp = { name: name.v, kind: 'relationship', typeName: null, variability: 'uniform', custom, meta: {} };
      let suffix: string | null = null;
      if (this.is('.') && this.peek(1)?.t === 'id') { this.p++; suffix = this.next()!.v; }
      if (this.is('=')) {
        this.p++;
        const v = this.parseValue();
        const targets = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string');
        if (suffix === null) prop.targets = targets;
      }
      if (this.is('(')) { this.p++; this.parseMetaBody(prop.meta, ')'); }
      return prop;
    }
    let typeName = first.v;
    if (this.is('[') && this.is(']', 1)) { typeName += '[]'; this.p += 2; }
    const nameTok = this.next();
    if (!nameTok || nameTok.t !== 'id') { this.warn(`usda: expected property name at line ${nameTok?.line ?? '?'}`); return null; }
    const prop: UsdProp = { name: nameTok.v, kind: 'attribute', typeName, variability: uniform ? 'uniform' : 'varying', custom, meta: {} };
    let suffix: string | null = null;
    if (this.is('.') && this.peek(1)?.t === 'id') { this.p++; suffix = this.next()!.v; }
    if (this.is('=')) {
      this.p++;
      if (suffix === 'connect') {
        const v = this.parseValue();
        prop.connections = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string');
      } else if (suffix === 'timeSamples') {
        this.expect('{');
        const times: number[] = [], values: UsdVal[] = [];
        while (this.peek() && !this.is('}')) {
          const tt = this.next()!;
          if (tt.t !== 'num') { this.warn(`usda: bad time sample key at line ${tt.line}`); break; }
          this.expect(':');
          times.push(Number(tt.v)); values.push(coerce(typeName, this.parseValue()));
          if (this.is(',')) this.p++;
        }
        this.expect('}');
        prop.timeSamples = { times, values };
      } else if (suffix === null) {
        prop.value = coerce(typeName, this.parseValue());
      } else {
        this.parseValue(); // unknown suffix (e.g. .spline) — consume
      }
    }
    if (this.is('(')) { this.p++; this.parseMetaBody(prop.meta, ')'); }
    return prop;
  }
}

function flattenListOp(v: UsdVal): UsdVal[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'object' && !(v instanceof Float64Array)) {
    const o = v as Record<string, UsdVal>;
    const keys = ['explicit', 'prepended', 'added', 'appended'];
    if (keys.some((k) => k in o)) return keys.flatMap((k) => (Array.isArray(o[k]) ? (o[k] as UsdVal[]) : []));
    if ('assetPath' in o) return [v];
    return [];
  }
  return [v];
}

/** Convert the parser's generic nested arrays into typed arrays by declared type. */
export function coerce(typeName: string, raw: UsdVal): UsdVal {
  const isArray = typeName.endsWith('[]');
  const base = typeName.replace(/\[\]$/, '');
  const flatten = (v: UsdVal, out: number[]) => { if (Array.isArray(v)) for (const x of v) flatten(x, out); else if (typeof v === 'number') out.push(v); else if (typeof v === 'boolean') out.push(v ? 1 : 0); };
  if (isArray) {
    if (!Array.isArray(raw)) return raw;
    if (/^(token|string|asset)$/.test(base)) return raw.map((x) => (x && typeof x === 'object' && 'assetPath' in (x as object) ? (x as UsdReference).assetPath : String(x)));
    if (base === 'bool') return Uint8Array.from(raw.map((x) => (x ? 1 : 0)));
    const nums: number[] = []; flatten(raw, nums);
    if (/^quat[fdh]$/.test(base)) { for (let i = 0; i + 3 < nums.length; i += 4) { const w = nums[i]; nums[i] = nums[i + 1]; nums[i + 1] = nums[i + 2]; nums[i + 2] = nums[i + 3]; nums[i + 3] = w; } }
    if (/^(int|uint|int64|uint64)$/.test(base) || /^(int|uint)[234]$/.test(base)) return Int32Array.from(nums);
    if (/double|matrix|timecode/i.test(base)) return Float64Array.from(nums);
    return Float32Array.from(nums);
  }
  if (base === 'asset' && raw && typeof raw === 'object' && 'assetPath' in (raw as object)) return (raw as UsdReference).assetPath;
  if (base === 'bool') return raw === true || raw === 1 || raw === 'true';
  if (/^quat[fdh]$/.test(base) && Array.isArray(raw) && raw.length === 4) { const q = raw as number[]; return [q[1], q[2], q[3], q[0]]; }
  if (Array.isArray(raw) && /^(matrix|float|double|half|int|uint|color|normal|point|vector|texCoord|quat|frame)/.test(base)) {
    const nums: number[] = []; flatten(raw, nums);
    return nums;
  }
  return raw;
}

export function readUsda(text: string): UsdLayerData {
  if (!/^#usda\s+1\.0/.test(text.trimStart())) throw new Error('Not a usda file (missing "#usda 1.0" header).');
  const body = text.replace(/^\s*#usda\s+1\.0[^\n]*\n?/, '');
  const parser = new Parser(tokenize(body));
  return parser.parseLayer();
}
