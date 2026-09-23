import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadScene } from '../src/index.js';

/**
 * A .gltf buffer/image URI is a relative (or absolute) filesystem path the
 * loader reads on the caller's behalf. `../../etc/passwd` or an absolute
 * path escaped the asset's own directory and got its bytes read straight
 * into the document — recoverable byte-for-byte from the accessor array,
 * with no path containment at all. An agent pointed at a third-party
 * .gltf (a download, another agent's output) was reading arbitrary files
 * off the host as a side effect of "look at this asset".
 */

let dir: string;
const secret = 'TOP-SECRET-KEY-AAAABBBBCCCCDDDD!!XXX'; // 37 bytes; padded to 36 below

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glbforge-traversal-'));
  await mkdir(join(dir, 'asset'));
  await mkdir(join(dir, 'secret'));
  await writeFile(join(dir, 'secret', 'secret.bin'), Buffer.from(secret.slice(0, 36)));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const gltfReferencing = (uri: string) => ({
  asset: { version: '2.0' },
  scenes: [{ nodes: [0] }],
  scene: 0,
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1e9, -1e9, -1e9], max: [1e9, 1e9, 1e9] }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
  buffers: [{ uri, byteLength: 36 }],
});

describe('a .gltf buffer URI that tries to leave the asset directory', () => {
  it('does not read a ../ path outside the asset directory', async () => {
    const path = join(dir, 'asset', 'evil.gltf');
    await writeFile(path, JSON.stringify(gltfReferencing('../secret/secret.bin')));
    const loaded = await loadScene(path);
    const acc = loaded.doc!.getRoot().listAccessors()[0];
    expect(acc.getArray()!.length).toBe(0);
    const text = Buffer.from(acc.getArray()!.buffer).toString('latin1');
    expect(text).not.toContain('TOP-SECRET');
  });

  it('does not read an absolute path outside the asset directory', async () => {
    const path = join(dir, 'asset', 'evil-abs.gltf');
    await writeFile(path, JSON.stringify(gltfReferencing(join(dir, 'secret', 'secret.bin'))));
    const loaded = await loadScene(path);
    const acc = loaded.doc!.getRoot().listAccessors()[0];
    expect(acc.getArray()!.length).toBe(0);
  });

  it('still resolves a buffer that legitimately sits next to the .gltf', async () => {
    await writeFile(join(dir, 'asset', 'data.bin'), Buffer.from(secret.slice(0, 36)));
    const path = join(dir, 'asset', 'good.gltf');
    await writeFile(path, JSON.stringify(gltfReferencing('data.bin')));
    const loaded = await loadScene(path);
    const acc = loaded.doc!.getRoot().listAccessors()[0];
    expect(acc.getArray()!.length).toBe(3 * 3);
  });
});
