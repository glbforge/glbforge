import type { Profile, ProfileRationale, RuleOverrides } from './types.js';

const MB = 1024 * 1024;

/** Where the methodology behind every cap is published. */
export const BUDGET_METHODOLOGY_URL = 'https://glbforge.dev/budgets/';

/**
 * Rule-pack stance shared by the web delivery profiles: a renderer does not
 * care whether a mesh is a closed solid, so topology findings are reported
 * as facts (info), never as warnings. An authoring or print profile says
 * otherwise about the same edges. Additive — caps and exit codes unchanged.
 */
const WEB_RULES: RuleOverrides = {
  packs: ['core-geometry@1', 'core-scene@1'],
  severity: {
    'topo/open-edges': 'info',
    'topo/non-manifold': 'info',
    'topo/floating-fragments': 'info',
    // A viewer frames whatever it gets; where the pivot sits and whether a
    // node transform is baked changes nothing on screen. Mirroring and
    // wrong units do (culling, camera framing), so those keep their default.
    'origin/outside-bounds': 'info',
    'xform/unapplied': 'info',
  },
};

/**
 * Budget profiles for common web delivery targets. Numbers are deliberately
 * opinionated: they describe what ships comfortably, not what merely loads.
 *
 * Profiles are VERSIONED. A cap never changes in place: any change is a new
 * version appended to PROFILE_VERSIONS with a changelog entry in
 * docs/BUDGETS.md, and `getProfile('mobile-hero@1')` keeps CI pinned to the
 * contract it was written against. `getProfile('mobile-hero')` is the latest.
 */
const mobileHeroV1: Profile = {
  name: 'mobile-hero',
  version: 1,
  description: 'Single hero asset on a mobile landing page (4G, mid-range GPU).',
  maxTriangles: 150_000,
  maxDrawCalls: 4,
  maxTextureSize: 2048,
  maxTextureBytes: 4 * MB,
  maxTextureVramBytes: 128 * MB,
  maxFileBytes: 6 * MB,
  maxMaterials: 2,
  minSsim: 0.94,
  rationale: {
    maxTriangles: 'A mid-range phone GPU (2019+ Adreno 6xx / Mali-G7x / Apple A12 class) rasterizes 150k triangles in well under a millisecond; the binding constraint is payload. 150k welded, quantized, meshopt-compressed triangles land around 1–2MB, which is what leaves room for textures inside the file cap. It is also where our fixtures stop losing visible detail (the Meshy 7 hero measures SSIM 0.958 at 150k).',
    maxDrawCalls: 'Every primitive is a draw call with its own state changes plus scene-graph cost on the JS side, and a hero shares the frame with the page itself (scroll, compositing, video). One to four is a hero; more is a scene.',
    maxTextureSize: 'A 2K RGBA8 texture with mipmaps is ~21MB of GPU memory; a color/normal/ORM set of three fits the VRAM cap. 4K quadruples that and rarely reads sharper on a phone-sized viewport.',
    maxTextureBytes: 'Compressed image payload inside the GLB. WebP at quality 82 (near-lossless for normal maps) keeps three 2K maps around 1–3MB.',
    maxTextureVramBytes: 'Decoded, mipmapped GPU memory. Mobile browsers share GPU memory with the OS and drop WebGL contexts that get greedy; 128MB leaves headroom for framebuffers, the DOM, and a second asset. KTX2/BasisU counts at its GPU-compressed size (~4–8x less), which is why the KTX2 path exists.',
    maxFileBytes: 'About 3–5 seconds on a typical 4G link (10–15Mbps effective) — the most a hero can hide behind a poster image before it reads as broken; under a second on Wi-Fi or 5G.',
    maxMaterials: 'Materials multiply shader variants and texture sets. A hero is one material, two when a glass or emissive part is unavoidable.',
    minSsim: 'Weakest of four fixed-camera views (256px, 2x supersampled, smooth shading, textured) before vs after optimization. Calibrated on the Meshy 7 fixture: the budget pass measures 0.958, a 40k-triangle version 0.896 with visibly merged hair strands. The floor sits between them.',
  },
  rules: WEB_RULES,
};

const desktopHeroV1: Profile = {
  name: 'desktop-hero',
  version: 1,
  description: 'Hero asset on a desktop-first marketing page.',
  maxTriangles: 500_000,
  maxDrawCalls: 8,
  maxTextureSize: 4096,
  maxTextureBytes: 12 * MB,
  maxTextureVramBytes: 256 * MB,
  maxFileBytes: 20 * MB,
  maxMaterials: 4,
  minSsim: 0.96,
  rationale: {
    maxTriangles: 'Integrated desktop GPUs handle 500k triangles per frame comfortably; beyond that, payload and parse time on first load dominate, not raster cost.',
    maxDrawCalls: 'Desktop browsers absorb more state changes per frame, and a desktop hero is often a small assembly (product + stand + shadow catcher).',
    maxTextureSize: 'A 4K color map can be justified on a large viewport where the hero fills half the screen; a 4K RGBA8 with mips is ~85MB decoded, so only the color map should be 4K.',
    maxTextureBytes: 'One 4K color map plus 2K normal/ORM maps in WebP.',
    maxTextureVramBytes: 'Desktop GPU memory is plentiful but shared with tabs and the compositor; 256MB keeps a two-asset page under half a gigabyte.',
    maxFileBytes: 'About 3 seconds on a 50Mbps connection; desktop visitors tolerate a progressive reveal behind a placeholder up to that.',
    maxMaterials: 'Four materials cover a typical product hero (body, glass, metal trim, screen) without turning into a material zoo.',
    minSsim: 'Desktop heroes are viewed larger, so the floor is stricter than mobile: budget-level simplification on our fixtures still clears 0.96.',
  },
  rules: WEB_RULES,
};

const productConfiguratorV1: Profile = {
  name: 'product-configurator',
  version: 1,
  description: 'Interactive product viewer; many assets may coexist.',
  maxTriangles: 250_000,
  maxDrawCalls: 12,
  maxTextureSize: 2048,
  maxTextureBytes: 8 * MB,
  maxTextureVramBytes: 128 * MB,
  maxFileBytes: 12 * MB,
  maxMaterials: 8,
  minSsim: 0.95,
  rationale: {
    maxTriangles: 'Configurators keep several variants resident and the camera gets close; 250k per asset balances close-up fidelity against having three or four assets loaded at once.',
    maxDrawCalls: 'Swappable parts are separate meshes by design (a draw call each), so the cap is higher than a hero — but still a dozen, not a hundred.',
    maxTextureSize: '2K keeps a multi-variant texture set inside the shared VRAM cap; configurators rarely benefit from 4K because the camera moves and materials swap.',
    maxTextureBytes: 'Room for a full PBR set (color, normal, ORM) at 2K in WebP plus one variant map.',
    maxTextureVramBytes: 'Same ceiling as mobile because a configurator page often IS on mobile, and several assets share it.',
    maxFileBytes: 'Configurator assets load on demand behind an explicit user action, so a slightly larger file is acceptable than a hero that must appear on first paint.',
    maxMaterials: 'Materials are the point of a configurator (colorways, finishes); eight covers realistic part counts while keeping shader compilation bounded.',
    minSsim: 'Close-up viewing argues for strict, coexistence argues for lenient; 0.95 is the midpoint and clears budget-level simplification on our fixtures.',
  },
  rules: WEB_RULES,
};

/**
 * v2 — identical caps, recalibrated numbers.
 *
 * The verification renderer used to sample base-color texels as if they were
 * linear while `baseColorFactor` is linear, and shaded and wrote pixels in
 * that same muddle. Fixing it (linear-light shading, sRGB in and out) moved
 * every SSIM the tool reports, so the rationales below no longer described
 * the measurement they were calibrated against — even though not one cap
 * changed. Rather than edit published text, v2 restates it against the
 * corrected renderer; `@1` still reads as what CI recorded before 0.9.0.
 *
 * The floors themselves were re-derived, not assumed: every profile's budget
 * pass still clears its floor with margin, and mobile-hero's counter-example
 * (the 40k version with visibly merged hair) still fails it. See the 0.9.0
 * entry in docs/BUDGETS.md for the full before/after table.
 */
const mobileHeroV2: Profile = {
  ...mobileHeroV1,
  version: 2,
  rationale: {
    ...mobileHeroV1.rationale,
    maxTriangles: 'A mid-range phone GPU (2019+ Adreno 6xx / Mali-G7x / Apple A12 class) rasterizes 150k triangles in well under a millisecond; the binding constraint is payload. 150k welded, quantized, meshopt-compressed triangles land around 1–2MB, which is what leaves room for textures inside the file cap. It is also where our fixtures stop losing visible detail (the Meshy 7 hero measures SSIM 0.964 at 150k).',
    minSsim: 'Weakest of four fixed-camera views (256px, 2x supersampled, smooth shading, textured) before vs after optimization. Calibrated on the Meshy 7 fixture: the budget pass measures 0.964 with 4K source textures (0.979 with 2K), a 40k-triangle version 0.913 with visibly merged hair strands. The floor sits between them.',
  },
};

const desktopHeroV2: Profile = {
  ...desktopHeroV1,
  version: 2,
  rationale: {
    ...desktopHeroV1.rationale,
    minSsim: 'Desktop heroes are viewed larger, so the floor is stricter than mobile: the budget pass to 500k measures 0.986–0.993 on our fixtures, clearing it either way.',
  },
};

const productConfiguratorV2: Profile = {
  ...productConfiguratorV1,
  version: 2,
  rationale: {
    ...productConfiguratorV1.rationale,
    minSsim: 'Close-up viewing argues for strict, coexistence argues for lenient; 0.95 is the midpoint, and the budget pass to 250k measures 0.977–0.987 on our fixtures.',
  },
};

/** Every published version of every profile, oldest first. Never edit a published entry. */
export const PROFILE_VERSIONS: Record<string, Profile[]> = {
  'mobile-hero': [mobileHeroV1, mobileHeroV2],
  'desktop-hero': [desktopHeroV1, desktopHeroV2],
  'product-configurator': [productConfiguratorV1, productConfiguratorV2],
};

/** Latest version of each profile. */
export const PROFILES: Record<string, Profile> = Object.fromEntries(
  Object.entries(PROFILE_VERSIONS).map(([name, versions]) => [name, versions[versions.length - 1]]),
);

/** "mobile-hero@1" — the label reports and CI logs should carry. */
export function profileLabel(profile: Profile): string {
  return `${profile.name}@${profile.version}`;
}

/**
 * Resolve a profile spec: "mobile-hero" (latest) or "mobile-hero@1" (pinned).
 */
export function getProfile(spec: string): Profile {
  const m = /^([a-z0-9-]+)(?:@(\d+))?$/i.exec(spec.trim());
  const name = m?.[1] ?? spec;
  const versions = PROFILE_VERSIONS[name];
  if (!versions) {
    throw new Error(
      `Unknown profile "${spec}". Available: ${Object.keys(PROFILE_VERSIONS).join(', ')} (pin a version with name@N, e.g. mobile-hero@1).`,
    );
  }
  if (!m?.[2]) return versions[versions.length - 1];
  const version = parseInt(m[2], 10);
  const hit = versions.find((p) => p.version === version);
  if (!hit) {
    throw new Error(
      `Profile "${name}" has no version ${version}. Published: ${versions.map((p) => p.version).join(', ')}.`,
    );
  }
  return hit;
}

/** Every cap key a rationale must cover. */
export const CAP_KEYS: Array<keyof ProfileRationale> = [
  'maxTriangles', 'maxDrawCalls', 'maxTextureSize', 'maxTextureBytes',
  'maxTextureVramBytes', 'maxFileBytes', 'maxMaterials', 'minSsim',
];
