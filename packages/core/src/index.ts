export * from './types.js';
export { PROFILES, PROFILE_VERSIONS, CAP_KEYS, BUDGET_METHODOLOGY_URL, getProfile, profileLabel } from './profiles.js';
export { analyze, type AnalyzeOptions } from './analyze/index.js';
export { runRules, RULE_IDS } from './rules.js';
export { optimize, type OptimizeOptions, type OptimizeSummary, type TextureEncoder } from './optimize.js';
export { createNodeIO } from './io.js';
export { extrudeImage, extrudeFromRgba, type ExtrudeOptions, type ExtrudeResult, type LayerInfo } from './extrude/index.js';
export { detectKtx2Encoder, ktx2Compress, type Ktx2Encoder } from './ktx2.js';
export { stripMaterials } from './optimize.js';
export { readFloat } from './accessors.js';
export { auditDirectory, listGlbs, OUTPUT_PATTERN, type AuditOptions, type AuditResult, type AuditRow } from './audit.js';
export { computeSmoothNormals } from './normals.js';
export { isDeforming, dominantJoints, simplifyDeformingPrimitive, type DeformingSimplifyOptions, type DeformingSimplifyResult } from './skinning.js';
export { toUsdz, buildUsdLayer, type UsdzOptions, type UsdzResult, type UsdzTextureEncoder } from './usdz.js';
export { writeUsda, type UsdLayer, type UsdPrim, type UsdProperty, type UsdAttribute, type UsdRelationship, type UsdValue } from './usd-ir.js';
export { writeUsdc } from './usdc.js';
export { storeZip, type ZipEntry } from './zip.js';
export { toStl, type StlOptions, type StlResult } from './stl.js';
export { detectGenerator, type GeneratorGuess, type GeneratorProfile } from './detect.js';
export { alignmentScore, sampleSurface, triangleSoup, type AlignmentScore } from './harness/align.js';
export {
  renderViews, renderRaw, computeFrame, defaultRig, verifyRig, thumbnailRig, sharpTextureDecoder,
  type RenderedView, type RawView, type RenderCamera, type RenderFrame, type RenderOptions, type TextureDecoder,
} from './harness/render.js';
export {
  perceptualDiff, perceptualSnapshot, perceptualCompare, compareViews, ssim, diffHeatmap, applyPerceptualVerdict,
  PERCEPTUAL_RULE, type PerceptualResult, type PerceptualVerdict, type PerceptualOptions, type ViewScore,
} from './harness/perceptual.js';
