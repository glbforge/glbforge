import type { Profile } from './types.js';

const MB = 1024 * 1024;

/**
 * Budget profiles for common web delivery targets. Numbers are deliberately
 * opinionated: they describe what ships comfortably, not what merely loads.
 */
export const PROFILES: Record<string, Profile> = {
  'mobile-hero': {
    name: 'mobile-hero',
    description: 'Single hero asset on a mobile landing page (4G, mid-range GPU).',
    maxTriangles: 150_000,
    maxDrawCalls: 4,
    maxTextureSize: 2048,
    maxTextureBytes: 4 * MB,
    maxTextureVramBytes: 128 * MB,
    maxFileBytes: 6 * MB,
    maxMaterials: 2,
  },
  'desktop-hero': {
    name: 'desktop-hero',
    description: 'Hero asset on a desktop-first marketing page.',
    maxTriangles: 500_000,
    maxDrawCalls: 8,
    maxTextureSize: 4096,
    maxTextureBytes: 12 * MB,
    maxTextureVramBytes: 256 * MB,
    maxFileBytes: 20 * MB,
    maxMaterials: 4,
  },
  'product-configurator': {
    name: 'product-configurator',
    description: 'Interactive product viewer; many assets may coexist.',
    maxTriangles: 250_000,
    maxDrawCalls: 12,
    maxTextureSize: 2048,
    maxTextureBytes: 8 * MB,
    maxTextureVramBytes: 128 * MB,
    maxFileBytes: 12 * MB,
    maxMaterials: 8,
  },
};

export function getProfile(name: string): Profile {
  const profile = PROFILES[name];
  if (!profile) {
    throw new Error(
      `Unknown profile "${name}". Available: ${Object.keys(PROFILES).join(', ')}`,
    );
  }
  return profile;
}
