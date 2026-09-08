import { describe, it, expect } from 'vitest';
import { CAP_KEYS, PROFILES, PROFILE_VERSIONS, getProfile, profileLabel } from '../src/index.js';

describe('versioned budget profiles', () => {
  it('resolves latest and pinned versions', () => {
    expect(getProfile('mobile-hero').version).toBe(PROFILE_VERSIONS['mobile-hero'].at(-1)!.version);
    expect(getProfile('mobile-hero@1').version).toBe(1);
    expect(profileLabel(getProfile('desktop-hero'))).toMatch(/^desktop-hero@\d+$/);
    expect(() => getProfile('mobile-hero@99')).toThrow(/no version 99/);
    expect(() => getProfile('nope')).toThrow(/Unknown profile/);
  });

  it('publishes a rationale for every cap of every version', () => {
    for (const versions of Object.values(PROFILE_VERSIONS)) {
      let last = 0;
      for (const p of versions) {
        expect(p.version).toBeGreaterThan(last); last = p.version;
        for (const key of CAP_KEYS) {
          expect(p.rationale[key]?.length ?? 0, `${p.name}@${p.version}.${key}`).toBeGreaterThan(40);
        }
        expect(p.minSsim).toBeGreaterThan(0.9);
        expect(p.minSsim).toBeLessThan(1);
      }
    }
    expect(Object.keys(PROFILES).sort()).toEqual(['desktop-hero', 'mobile-hero', 'product-configurator']);
  });

  it('keeps published caps frozen (v1 contract)', () => {
    const v1 = getProfile('mobile-hero@1');
    expect([v1.maxTriangles, v1.maxDrawCalls, v1.maxTextureSize, v1.maxTextureBytes, v1.maxTextureVramBytes, v1.maxFileBytes, v1.maxMaterials, v1.minSsim])
      .toEqual([150_000, 4, 2048, 4 * 1048576, 128 * 1048576, 6 * 1048576, 2, 0.94]);
  });
});
