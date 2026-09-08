/**
 * Minimal USD layer model shared by the ASCII (usda) and binary (usdc)
 * serializers. Only what GLBForge emits: Xform/Mesh/Scope/Material/Shader
 * prims, typed attributes with defaults or connections, relationships,
 * apiSchemas, and layer metadata.
 */
export type UsdScalar = number | boolean | string;
export type UsdValue = UsdScalar | number[] | string[] | Float32Array | Int32Array | Uint32Array;

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
  prims: UsdPrim[];
}

const f = (n: number) => (Object.is(n, -0) ? 0 : n).toPrecision(7).replace(/\.?0+$/, '').replace(/^-0$/, '0');
const tuple = (xs: ArrayLike<number>, from = 0, len = xs.length) => {
  const parts: string[] = [];
  for (let i = from; i < from + len; i++) parts.push(f(xs[i]));
  return `(${parts.join(', ')})`;
};
const quote = (s: string) => JSON.stringify(s);

/** Element width of a vector-typed attribute (0 for scalars/tokens). */
export function vectorWidth(typeName: string): number {
  const base = typeName.replace(/\[\]$/, '');
  if (/^(float2|texCoord2f|double2)$/.test(base)) return 2;
  if (/^(float3|color3f|normal3f|point3f|vector3f|double3)$/.test(base)) return 3;
  if (/^(float4|color4f|double4)$/.test(base)) return 4;
  if (base === 'matrix4d') return 16;
  return 0;
}

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
    for (let i = 0; i + w <= xs.length; i += w) parts.push(tuple(xs, i, w));
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
      return vectorWidth(base) ? tuple(value as ArrayLike<number>) : f(value as number);
  }
}

/** ASCII USD (usda) serializer. */
export function writeUsda(layer: UsdLayer): string {
  const out: string[] = [];
  out.push('#usda 1.0', '(', `    defaultPrim = ${quote(layer.defaultPrim)}`, `    metersPerUnit = ${f(layer.metersPerUnit)}`, `    upAxis = ${quote(layer.upAxis)}`);
  if (layer.doc) out.push(`    doc = ${quote(layer.doc)}`);
  out.push(')', '');
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
      if (prop.connect !== undefined) {
        out.push(`${head}.connect = <${prop.connect}>`);
      } else if (prop.value !== undefined) {
        const meta = prop.interpolation ? ` (\n${ind}        interpolation = ${quote(prop.interpolation)}\n${ind}    )` : '';
        out.push(`${head} = ${formatUsdaValue(prop.typeName, prop.value)}${meta}`);
      } else {
        out.push(head);
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
