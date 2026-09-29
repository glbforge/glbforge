/**
 * Every command that reads a user's .glb went straight from `io.readBinary`
 * to the top-level `.catch`, which prints only `err.message` — no filename,
 * no indication it was even a parse failure ("Cannot read properties of
 * undefined (reading 'buffer')" for a GLB whose binary chunk gltf-transform's
 * own writer/reader round-trip can't agree on, e.g. a zero-vertex mesh).
 * `inspect`/`diff` already frame the same failure as "<file> could not be
 * parsed as glb: <reason>" via `loadScene`; this checks every other command
 * reads through `readGlb()` and gets that same framing instead of a bare,
 * unattributed one-liner.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Document } from '@gltf-transform/core';
import { createNodeIO } from '@glbforge/core';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = join(root, 'packages', 'cli', 'dist', 'index.js');
const ready = existsSync(cli);

let badGlb: string;

beforeAll(async () => {
  // A mesh with a 0-length POSITION accessor: gltf-transform happily writes
  // it (a 0-byte binary chunk), but its own NodeIO.readBinary throws reading
  // it back — "Cannot read properties of undefined (reading 'buffer')" —
  // which is the raw, fileless error this test guards against.
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc.createAccessor().setType('VEC3').setArray(new Float32Array(0)).setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute('POSITION', position).setMode(4 /* TRIANGLES */);
  const mesh = doc.createMesh().addPrimitive(prim);
  const node = doc.createNode().setMesh(mesh);
  const scene = doc.createScene().addChild(node);
  doc.getRoot().setDefaultScene(scene);
  doc.getRoot().getAsset().version = '2.0';

  const io = await createNodeIO();
  const bytes = await io.writeBinary(doc);
  const dir = mkdtempSync(join(tmpdir(), 'glbforge-read-errors-'));
  badGlb = join(dir, 'zero-vertex.glb');
  await writeFile(badGlb, bytes);
});

describe.skipIf(!ready)('every command names the file and the stage when a .glb fails to parse', () => {
  const cases: Array<[string, string[]]> = [
    ['analyze', ['analyze']],
    ['optimize', ['optimize']],
    ['stl', ['stl']],
    ['usdz', ['usdz']],
    ['animate', ['animate']],
  ];

  for (const [label, args] of cases) {
    it(`\`glbforge ${label}\` reports "<file> could not be parsed as glb: <reason>", not a bare error`, async () => {
      await expect(run('node', [cli, ...args, badGlb])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('zero-vertex.glb could not be parsed as glb:'),
      });
    });
  }

  it('`glbforge verify` (two-file read) also names the failing file', async () => {
    await expect(run('node', [cli, 'verify', badGlb, badGlb])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('zero-vertex.glb could not be parsed as glb:'),
    });
  });
});
