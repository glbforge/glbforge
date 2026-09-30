import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A hook the "interrupted swap" test can arm; every other call passes
// straight through to the real rename().
const renameOverride = vi.hoisted(() => ({ next: null as null | (() => Promise<never>) }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (renameOverride.next) {
        const fn = renameOverride.next;
        renameOverride.next = null;
        return fn();
      }
      return actual.rename(...args);
    },
  };
});

const { writeOutAtomic } = await import('../src/outputs.js');

const tmpFiles = async (dir: string) => (await readdir(dir)).filter((f) => f.endsWith('.tmp'));

describe('writeOutAtomic', () => {
  let dir: string;

  afterEach(async () => {
    renameOverride.next = null;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('replaces the target file whole and leaves no temp file behind', async () => {
    dir = await mkdtemp(join(tmpdir(), 'glbforge-outputs-'));
    const out = join(dir, 'model.glb');
    await writeOutAtomic(out, Buffer.from('first'));
    await writeOutAtomic(out, Buffer.from('second, and longer than first'));
    expect(await readFile(out, 'utf8')).toBe('second, and longer than first');
    expect(await tmpFiles(dir)).toEqual([]);
  });

  it('never leaves a truncated or partial file at `out` if the swap is interrupted before the rename', async () => {
    // Stands in for the process dying between the temp write and the
    // rename — an orchestrator's call timeout, an OOM kill, a crashed
    // native dependency. A plain `writeFile(out, bytes)` would already have
    // truncated `out` by this point; the atomic swap must not have touched
    // it yet.
    dir = await mkdtemp(join(tmpdir(), 'glbforge-outputs-'));
    const out = join(dir, 'model.glb');
    await writeFile(out, 'previous, complete output');
    renameOverride.next = async () => { throw new Error('killed mid-swap'); };

    await expect(writeOutAtomic(out, Buffer.from('X'.repeat(1_000_000)))).rejects.toThrow('killed mid-swap');

    expect(await readFile(out, 'utf8')).toBe('previous, complete output');
    expect(await tmpFiles(dir)).toEqual([]);
  });
});
