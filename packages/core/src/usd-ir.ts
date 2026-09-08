/**
 * Minimal USD layer model shared by the ASCII (usda) and binary (usdc)
 * serializers. Only what GLBForge emits: Xform/Mesh/Scope/Material/Shader
 * prims, typed attributes with defaults or connections, relationships,
 * apiSchemas, and layer metadata.
 */
export type UsdScalar = number | boolean | string;
export type UsdValue = UsdScalar | number[] | string[] | Float32Array | Float64Array | Int32Array | Uint32Array;

/** Time-sampled values: one UsdValue per time code. */
export interface UsdTimeSamples { times: number[]; values: UsdValue[] }

export interface UsdAttribute {
  kind: 'attribute';
  name: string;
  /** USD type name, e.g. "float", "color3f", "point3f[]", "texCoord2f[]", "matrix4d", "asset", "token[]". */
  typeName: string;
  uniform?: boolean;
  value?: UsdValue;
  /** Connection target (an attribute path) — written instead of a value. */
  connect?: string;
  /** Primvar / normals interpolation metadata. */
  interpolation?: string;
  /** Primvar element size (e.g. 4 for skel:jointIndices with 4 influences per vertex). */
  elementSize?: number;
  /** Animated attribute: written as timeSamples instead of a default. */
  samples?: UsdTimeSamples;
}

export interface UsdRelationship {
  kind: 'relationship';
  name: string;
  targets: string[];
}

export type UsdProperty = UsdAttribute | UsdRelationship;

export interface UsdPrim {
  name: string;
  path: string;
  typeName: string;
  apiSchemas?: string[];
  properties: UsdProperty[];
  children: UsdPrim[];
}

export interface UsdLayer {
  defaultPrim: string;
  metersPerUnit: number;
  upAxis: 'Y' | 'Z';
  doc?: string;
  /** Animation range, when the layer carries time samples. */
  startTimeCode?: number;
  endTimeCode?: number;
  timeCodesPerSecond?: number;
  framesPerSecond?: number;
  prims: UsdPrim[];
}

const f = (n: number) => { const v = Number(n.toPrecision(7)); return Object.is(v, -0) || v === 0 ? '0' : String(v); };
const tuple = (xs: ArrayLike<number>, from = 0, len = xs.length) => {
  const parts: string[] = [];
  for (let i = from; i < from + len; i++) parts.push(f(xs[i]));
  return `(${parts.join(', ')})`;
};
const quote = (s: string) => JSON.stringify(s);

/** Element width of a vector-typed attribute (0 for scalars/tokens). */
export function vectorWidth(typeName: string): number {
  const base = typeName.replace(/\[\]$/, '');
  if (/^(float2|texCoord2f|double2|half2)$/.test(base)) return 2;
  if (/^(float3|color3f|normal3f|point3f|vector3f|double3|half3)$/.test(base)) return 3;
  if (/^(float4|color4f|double4|half4|quatf|quatd|quath)$/.test(base)) return 4;
  if (base === 'matrix4d') return 16;
  return 0;
}

/** Quaternions are kept as (x, y, z, w) in the IR (glTF order); USD text prints (w, x, y, z). */
export const isQuat = (typeName: string) => /^quat[fdh](\[\])?$/.test(typeName);

export function formatUsdaValue(typeName: string, value: UsdValue): string {
  const isArray = typeName.endsWith('[]');
  const base = typeName.replace(/\[\]$/, '');
  if (isArray) {
    if (base === 'token' || base === 'string') return `[${(value as string[]).map(quote).join(', ')}]`;
    if (base === 'asset') return `[${(value as string[]).map((s) => `@${s}@`).join(', ')}]`;
    const xs = value as ArrayLike<number>;
    const w = vectorWidth(base);
    if (w === 0) return `[${Array.from(xs as ArrayLike<number>).map((n) => (base === 'int' ? String(n | 0) : f(n))).join(', ')}]`;
    const parts: string[] = [];
    if (base === 'matrix4d') {
      for (let i = 0; i + 16 <= xs.length; i += 16) parts.push(`( ${tuple(xs, i, 4)}, ${tuple(xs, i + 4, 4)}, ${tuple(xs, i + 8, 4)}, ${tuple(xs, i + 12, 4)} )`);
    } else if (isQuat(base)) {
      for (let i = 0; i + 4 <= xs.length; i += 4) parts.push(`(${f(xs[i + 3])}, ${f(xs[i])}, ${f(xs[i + 1])}, ${f(xs[i + 2])})`);
    } else {
      for (let i = 0; i + w <= xs.length; i += w) parts.push(tuple(xs, i, w));
    }
    return `[${parts.join(', ')}]`;
  }
  switch (base) {
    case 'bool': return value ? 'true' : 'false';
    case 'int': return String((value as number) | 0);
    case 'token': case 'string': return quote(String(value));
    case 'asset': return `@${value}@`;
    case 'matrix4d': {
      const m = value as ArrayLike<number>;
      return `( ${tuple(m, 0, 4)}, ${tuple(m, 4, 4)}, ${tuple(m, 8, 4)}, ${tuple(m, 12, 4)} )`;
    }
    default:
      if (isQuat(base)) { const q = value as ArrayLike<number>; return `(${f(q[3])}, ${f(q[0])}, ${f(q[1])}, ${f(q[2])})`; }
      return vectorWidth(base) ? tuple(value as ArrayLike<number>) : f(value as number);
  }
}

/** ASCII USD (usda) serializer. */
export function writeUsda(layer: UsdLayer): string {
  const out: string[] = [];
  out.push('#usda 1.0', '(', `    defaultPrim = ${quote(layer.defaultPrim)}`);
  if (layer.doc) out.push(`    doc = ${quote(layer.doc)}`);
  if (layer.endTimeCode !== undefined) out.push(`    endTimeCode = ${f(layer.endTimeCode)}`);
  if (layer.framesPerSecond !== undefined) out.push(`    framesPerSecond = ${f(layer.framesPerSecond)}`);
  out.push(`    metersPerUnit = ${f(layer.metersPerUnit)}`);
  if (layer.startTimeCode !== undefined) out.push(`    startTimeCode = ${f(layer.startTimeCode)}`);
  if (layer.timeCodesPerSecond !== undefined) out.push(`    timeCodesPerSecond = ${f(layer.timeCodesPerSecond)}`);
  out.push(`    upAxis = ${quote(layer.upAxis)}`, ')', '');
  const prim = (p: UsdPrim, depth: number) => {
    const ind = '    '.repeat(depth);
    if (p.apiSchemas?.length) {
      out.push(`${ind}def ${p.typeName} ${quote(p.name)} (`, `${ind}    prepend apiSchemas = [${p.apiSchemas.map(quote).join(', ')}]`, `${ind})`);
    } else {
      out.push(`${ind}def ${p.typeName} ${quote(p.name)}`);
    }
    out.push(`${ind}{`);
    for (const prop of p.properties) {
      if (prop.kind === 'relationship') {
        out.push(`${ind}    rel ${prop.name} = ${prop.targets.length === 1 ? `<${prop.targets[0]}>` : `[${prop.targets.map((t) => `<${t}>`).join(', ')}]`}`);
        continue;
      }
      const head = `${ind}    ${prop.uniform ? 'uniform ' : ''}${prop.typeName} ${prop.name}`;
      const metaLines: string[] = [];
      if (prop.elementSize !== undefined) metaLines.push(`${ind}        elementSize = ${prop.elementSize}`);
      if (prop.interpolation) metaLines.push(`${ind}        interpolation = ${quote(prop.interpolation)}`);
      const meta = metaLines.length ? ` (\n${metaLines.join('\n')}\n${ind}    )` : '';
      if (prop.connect !== undefined) {
        out.push(`${head}.connect = <${prop.connect}>`);
      } else if (prop.samples) {
        out.push(`${head}.timeSamples = {`);
        prop.samples.times.forEach((t, i) => out.push(`${ind}        ${f(t)}: ${formatUsdaValue(prop.typeName, prop.samples!.values[i])},`));
        out.push(`${ind}    }${meta}`);
      } else if (prop.value !== undefined) {
        out.push(`${head} = ${formatUsdaValue(prop.typeName, prop.value)}${meta}`);
      } else {
        out.push(`${head}${meta}`);
      }
    }
    for (let i = 0; i < p.children.length; i++) {
      out.push('');
      prim(p.children[i], depth + 1);
    }
    out.push(`${ind}}`);
  };
  layer.prims.forEach((p, i) => { if (i) out.push(''); prim(p, 0); });
  out.push('');
  return out.join('\n');
}
