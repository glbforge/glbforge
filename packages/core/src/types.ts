/** Severity of a finding produced by a rule. */
export type Severity = 'error' | 'warn' | 'info';

export interface Finding {
  ruleId: string;
  severity: Severity;
  message: string;
  /** Actionable next step, phrased for the asset author. */
  suggestion?: string;
  data?: Record<string, unknown>;
}

/** A named performance budget an asset is checked against. */
export interface Profile {
  name: string;
  description: string;
  maxTriangles: number;
  maxDrawCalls: number;
  /** Max texture dimension (px) on either axis. */
  maxTextureSize: number;
  /** Max total compressed image payload (bytes). */
  maxTextureBytes: number;
  /** Max estimated GPU memory for textures once uploaded (bytes). */
  maxTextureVramBytes: number;
  maxFileBytes: number;
  maxMaterials: number;
}

export interface TopologyStats {
  /** Edges belonging to exactly one triangle (holes / open surfaces). */
  boundaryEdges: number;
  /** Edges shared by 3+ triangles. */
  nonManifoldEdges: number;
  /** Triangles with repeated or position-coincident corners. */
  degenerateTriangles: number;
  /** Vertices duplicating another vertex's position (includes legitimate UV-seam splits). */
  duplicateVertexPositions: number;
  /** Vertices identical across ALL attributes — truly unwelded, pure waste. */
  redundantVertices: number;
  uniquePositions: number;
}

export interface PrimitiveStats {
  meshName: string;
  triangles: number;
  vertices: number;
  indexed: boolean;
  attributes: string[];
  materialName: string | null;
}

export interface GeometryStats {
  meshCount: number;
  primitiveCount: number;
  /** One draw call per primitive is the floor for real renderers. */
  drawCallEstimate: number;
  triangles: number;
  vertices: number;
  primitives: PrimitiveStats[];
  primsMissingNormals: number;
  primsMissingUVs: number;
  primsUnindexed: number;
  bounds: { min: number[]; max: number[]; size: number[] } | null;
  topology: TopologyStats | null;
}

export interface TextureStats {
  name: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  bytes: number;
  /** Whether the encoded image carries an alpha channel (null = unknown format). */
  hasAlpha: boolean | null;
  /** Estimated GPU memory once decoded/uploaded, incl. mips. */
  vramBytes: number;
  /** Material slots referencing this texture, e.g. "Hair/baseColor". */
  slots: string[];
}

export interface MaterialStats {
  name: string;
  alphaMode: string;
  doubleSided: boolean;
  textureSlots: string[];
}

export interface AnalysisResult {
  file: { path: string | null; bytes: number };
  asset: { generator: string | null; extensionsUsed: string[] };
  scene: { scenes: number; nodes: number; skins: number; animations: number };
  geometry: GeometryStats;
  materials: MaterialStats[];
  /** Groups of materials with identical render state (merge candidates). */
  duplicateMaterialGroups: string[][];
  textures: TextureStats[];
  textureBytesTotal: number;
  /** Estimated total GPU memory for all textures (decoded RGBA or KTX2-compressed). */
  textureVramTotal: number;
  profile: Profile;
  findings: Finding[];
  /** 0-100. Errors -15, warnings -5. */
  score: number;
  /** True when no error-severity findings. */
  passed: boolean;
}
