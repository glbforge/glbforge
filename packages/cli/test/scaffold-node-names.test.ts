/**
 * `glbforge scaffold` emits `<primitive object={scene} />`, which throws
 * away exactly the named-node structure the forge pipeline creates on
 * purpose (`extrudeImage({ layers: 'auto' })` gives each layer its own
 * mesh node and material). drei's `useGLTF` already parses those names into
 * `nodes`/`materials` maps at runtime; the emitted viewer just never told
 * an agent they exist, so hooking up interaction on one part meant a
 * separate `glbforge inspect` call first to learn the names. This asserts
 * the generated file states them instead.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldViewer } from '../src/scaffold.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('glbforge scaffold: named mesh nodes', () => {
  it("lists a multi-mesh asset's node names and how to address one via useGLTF", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'glbforge-scaffold-names-'));
    await scaffoldViewer(join(root, 'site/models/plush.glb'), dir);
    const app = await readFile(join(dir, 'src', 'App.tsx'), 'utf8');

    expect(app).toContain('layer-0');
    expect(app).toContain('layer-1');
    expect(app).toContain('layer-2');
    expect(app).toContain('layer-3');
    // Points at the runtime escape hatch, not just the names.
    expect(app).toContain('nodes, materials');
    expect(app).toMatch(/nodes\['layer-0'\]/);
  });

  it("names a single-mesh asset's one node instead of staying silent", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'glbforge-scaffold-names-'));
    await scaffoldViewer(join(root, 'assets', 'sample-ring.glb'), dir);
    const app = await readFile(join(dir, 'src', 'App.tsx'), 'utf8');

    expect(app).toContain('"extrusion"');
  });
});
