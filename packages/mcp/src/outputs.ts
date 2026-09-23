/**
 * Output paths, settled before the work instead of after it.
 *
 * Every mutating tool takes an `out` and writes it last, once the expensive
 * part is done. A missing output directory — the ordinary case for "optimize
 * it and save it to public/" — therefore surfaced as a bare ENOENT *after*
 * the pipeline had run: 40 seconds of optimizing a 2M-triangle asset thrown
 * away to learn that a folder did not exist yet.
 *
 * So `out` is resolved first, in milliseconds. The directory is created,
 * because that is what "save it to public/" means and the tool already owns
 * the path it was handed. What creating a directory cannot fix — an `out`
 * that is itself a directory, a file where a directory should be, a parent
 * this process cannot write — fails immediately with OUTPUT_NOT_WRITABLE and
 * the path it could not use, before a single triangle is read.
 *
 * `dry_run` writes nothing, so it creates nothing either: the filesystem is
 * left exactly as it was.
 */
import { access, mkdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';

const unwritable = (message: string) => Object.assign(new Error(message), { code: 'OUTPUT_NOT_WRITABLE' });

/**
 * Make `out` writable (creating its directory) or explain why it cannot be,
 * before the caller starts working. Call it at the top of a handler, not next
 * to the writeFile it protects.
 */
export async function prepareOut(out: string | undefined, dryRun = false): Promise<void> {
  if (!out || dryRun) return;
  const dir = dirname(out);
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'error';
    const why = code === 'EEXIST' || code === 'ENOTDIR'
      ? `a file already exists at ${dir}`
      : `${dir} could not be created (${code})`;
    throw unwritable(`Cannot write ${out}: ${why}. Pass "out" as a file path under a directory this process may write.`);
  }
  // mkdir is happy with a directory that already exists and is read-only; the
  // write would not be.
  try {
    await access(dir, constants.W_OK);
  } catch {
    throw unwritable(`Cannot write ${out}: the directory ${dir} is not writable by this process.`);
  }
  const existing = await stat(out).catch(() => null);
  if (existing?.isDirectory()) {
    throw unwritable(`Cannot write ${out}: that path is a directory. Pass "out" as the full file path, e.g. ${join(out, 'model.glb')}.`);
  }
}
