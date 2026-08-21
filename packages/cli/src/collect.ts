import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Training-corpus collection: when GLBFORGE_TRAINING_DIR is set, generation
 * commands deposit their results with provenance metadata. Meshy outputs are
 * quarantined to eval-only (ToS + partnership); MIT-model outputs and forge
 * results are trainable.
 */
export async function collectSample(opts: {
  provenance: 'forge' | 'open-models' | 'meshy-eval-only' | 'own';
  glbPath: string;
  sourceImagePath?: string;
  meta: Record<string, unknown>;
}): Promise<void> {
  const base = process.env.GLBFORGE_TRAINING_DIR;
  if (!base) return; // collection is opt-in
  try {
    const slug = `${new Date().toISOString().slice(0, 10)}-${Math.abs(
      [...JSON.stringify(opts.meta) + opts.glbPath].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7),
    ).toString(36)}`;
    const dir = join(base, opts.provenance, slug);
    await mkdir(dir, { recursive: true });
    await cp(opts.glbPath, join(dir, 'mesh.glb'));
    if (opts.sourceImagePath) {
      const ext = opts.sourceImagePath.split('.').pop();
      await cp(opts.sourceImagePath, join(dir, `source.${ext}`));
    }
    await writeFile(join(dir, 'meta.json'), JSON.stringify({
      ...opts.meta,
      provenance: opts.provenance,
      collectedAt: new Date().toISOString(),
      trainable: opts.provenance !== 'meshy-eval-only',
    }, null, 2));
    console.log(`  ⊕ collected → training/${opts.provenance}/${slug}`);
  } catch (err) {
    console.error(`  (collection skipped: ${err instanceof Error ? err.message : err})`);
  }
}
