/**
 * Data model produced by the USD readers (usda text, usdc crate, usdz
 * package): one layer's prims, properties, metadata and declared
 * composition arcs. Nothing is composed — references, payloads, sublayers,
 * variants and clips are reported, not resolved.
 */
export type UsdVal = unknown;

export interface UsdListOp<T = UsdVal> {
  isExplicit?: boolean;
  explicit?: T[];
  added?: T[];
  prepended?: T[];
  appended?: T[];
  deleted?: T[];
  ordered?: T[];
}

export interface UsdReference {
  assetPath: string;
  primPath: string;
  offset?: number;
  scale?: number;
}

export interface UsdTimeSamplesData {
  times: number[];
  values: UsdVal[];
}

export interface UsdProp {
  name: string;
  kind: 'attribute' | 'relationship';
  typeName: string | null;
  variability: 'uniform' | 'varying';
  custom: boolean;
  value?: UsdVal;
  connections?: string[];
  targets?: string[];
  timeSamples?: UsdTimeSamplesData;
  meta: Record<string, UsdVal>;
}

export interface UsdPrimNode {
  path: string;
  name: string;
  specifier: 'def' | 'over' | 'class';
  typeName: string | null;
  meta: Record<string, UsdVal>;
  apiSchemas: string[];
  /** Composition arcs declared on this prim, e.g. "references: ./ref.usda", "variantSet: lod". */
  arcs: string[];
  properties: UsdProp[];
  children: UsdPrimNode[];
}

export interface UsdLayerData {
  format: 'usda' | 'usdc';
  /** Crate file version, e.g. "0.8.0". */
  crateVersion?: string;
  meta: Record<string, UsdVal>;
  prims: UsdPrimNode[];
  primCount: number;
  warnings: string[];
}

export const LIST_OP_KEYS: Array<keyof UsdListOp> = ['explicit', 'added', 'prepended', 'appended', 'deleted', 'ordered'];

export function isListOp(v: UsdVal): v is UsdListOp {
  return !!v && typeof v === 'object' && !Array.isArray(v) && LIST_OP_KEYS.some((k) => k in (v as object));
}

/** Items a list op contributes (explicit ∪ prepended ∪ added ∪ appended), in that order. */
export function listOpItems<T = UsdVal>(v: UsdVal): T[] {
  if (Array.isArray(v)) return v as T[];
  if (!isListOp(v)) return v === undefined || v === null ? [] : [v as T];
  return [...(v.explicit ?? []), ...(v.prepended ?? []), ...(v.added ?? []), ...(v.appended ?? [])] as T[];
}

export const asNum = (v: UsdVal, d = 0): number => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : d);
export const asStr = (v: UsdVal): string | null => (typeof v === 'string' ? v : null);
export function asNumArray(v: UsdVal): ArrayLike<number> & Iterable<number> | null {
  if (v instanceof Float32Array || v instanceof Float64Array || v instanceof Int32Array || v instanceof Uint32Array || v instanceof Uint16Array || v instanceof Int16Array || v instanceof Uint8Array || v instanceof Int8Array) return v;
  if (Array.isArray(v) && (v.length === 0 || typeof v[0] === 'number')) return v as number[];
  if (typeof v === 'number') return [v];
  return null;
}
export function asStrArray(v: UsdVal): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return [v];
  return listOpItems<string>(v).filter((x) => typeof x === 'string');
}

export function findProp(prim: UsdPrimNode, name: string): UsdProp | undefined {
  return prim.properties.find((p) => p.name === name);
}

/** Walk every prim depth-first. */
export function* walkPrims(prims: UsdPrimNode[]): Generator<UsdPrimNode> {
  for (const p of prims) { yield p; yield* walkPrims(p.children); }
}

export function primAt(layer: UsdLayerData, path: string): UsdPrimNode | undefined {
  for (const p of walkPrims(layer.prims)) if (p.path === path) return p;
  return undefined;
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}
