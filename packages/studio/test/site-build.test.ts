/**
 * The committed `site/studio/` bundle is what glbforge.dev serves, and it is a
 * build artifact in the tree — so nothing but a test notices when it is built
 * the wrong way. It has been built the wrong way once: `pnpm build` instead of
 * `pnpm build:site` lost `--base=/studio/`, the page asked for `/assets/*`
 * under a site that serves them from `/studio/assets/*`, and the Studio was a
 * blank page on every visit until someone opened devtools.
 *
 * Both halves of that failure are checked here: the prefix, and that every
 * referenced file is actually on disk (a hand-edited or half-copied index.html
 * points at bundles that no longer exist).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteStudio = resolve(dirname(fileURLToPath(import.meta.url)), '../../../site/studio');

describe('the committed site/studio bundle', () => {
  const html = readFileSync(resolve(siteStudio, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
  const bundled = refs.filter((r) => r.includes('/assets/'));

  it('references its own assets, so it was built with --base=/studio/', () => {
    expect(bundled.length).toBeGreaterThan(0);
    for (const ref of bundled) expect(ref.startsWith('/studio/assets/')).toBe(true);
  });

  it('references only files that exist', () => {
    for (const ref of bundled) {
      expect(existsSync(resolve(siteStudio, ref.replace('/studio/', '')))).toBe(true);
    }
  });
});
