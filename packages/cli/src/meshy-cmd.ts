import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { MeshyClient, type MeshyTask, type TaskKind } from '@glbforge/meshy';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** Local paths become data URIs; http(s) URLs pass through untouched. */
async function toImageUrl(input: string): Promise<string> {
  if (/^https?:\/\//.test(input)) return input;
  const mime = MIME[extname(input).toLowerCase()];
  if (!mime) throw new Error(`Unsupported image type "${extname(input)}" (png/jpg/webp).`);
  const bytes = await readFile(input);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function progressLine(task: MeshyTask): void {
  process.stdout.write(
    `\r  ${task.status.toLowerCase().padEnd(12)} ${task.progress}%   `,
  );
  if (task.status === 'SUCCEEDED') process.stdout.write('\n');
}

async function downloadTo(
  client: MeshyClient,
  task: MeshyTask,
  outPath: string,
  sourceImagePath?: string,
): Promise<void> {
  const bytes = await client.downloadModel(task, 'glb');
  await writeFile(outPath, bytes);
  console.log(`  saved ${outPath} (${(bytes.byteLength / 1048576).toFixed(1)}MB)`);
  const { collectSample } = await import('./collect.js');
  await collectSample({
    provenance: 'meshy-eval-only', glbPath: outPath, sourceImagePath,
    meta: { generator: 'meshy', taskId: task.id },
  });
}

export function registerMeshyCommands(
  program: Command,
  optimizeFile: (input: string, output: string, profileName: string) => Promise<boolean>,
): void {
  const meshy = program
    .command('meshy')
    .description('Generate 3D assets via the Meshy API (needs MESHY_API_KEY).');

  meshy
    .command('image')
    .description('Image → 3D. Local file or URL in; textured GLB out.')
    .argument('<image>', 'path or URL of the source image')
    .option('-o, --out <file>', 'output GLB path', 'meshy-output.glb')
    .option('--no-texture', 'geometry stage only (faster, cheaper)')
    .option('--pbr', 'generate PBR maps (with texturing)')
    .option('--target-polycount <n>', 'ask Meshy for a polycount target', (v) => parseInt(v, 10))
    .option('--optimize', 'run glbforge optimize on the result')
    .option('-p, --profile <name>', 'budget profile for --optimize', 'mobile-hero')
    .action(async (image: string, opts: {
      out: string; texture: boolean; pbr?: boolean;
      targetPolycount?: number; optimize?: boolean; profile: string;
    }) => {
      const client = new MeshyClient();
      const taskId = await client.createImageTo3D({
        image_url: await toImageUrl(image),
        should_texture: opts.texture,
        enable_pbr: opts.pbr,
        target_polycount: opts.targetPolycount,
      });
      console.log(`  task ${taskId}`);
      const task = await client.waitForTask('image-to-3d', taskId, {
        onProgress: progressLine,
      });
      await downloadTo(client, task, opts.out, image);
      if (opts.optimize) {
        const passed = await optimizeFile(
          opts.out,
          opts.out.replace(/\.glb$/i, '') + '.web.glb',
          opts.profile,
        );
        process.exitCode = passed ? 0 : 1;
      }
    });

  meshy
    .command('text')
    .description('Text → 3D (preview + refine unless --no-refine).')
    .argument('<prompt>', 'what to generate')
    .option('-o, --out <file>', 'output GLB path', 'meshy-output.glb')
    .option('--no-refine', 'stop after the untextured preview stage')
    .option('--art-style <style>', 'realistic | sculpture')
    .option('--seed <n>', 'seed for reproducible geometry', (v) => parseInt(v, 10))
    .option('--optimize', 'run glbforge optimize on the result')
    .option('-p, --profile <name>', 'budget profile for --optimize', 'mobile-hero')
    .action(async (prompt: string, opts: {
      out: string; refine: boolean; artStyle?: 'realistic' | 'sculpture';
      seed?: number; optimize?: boolean; profile: string;
    }) => {
      const client = new MeshyClient();
      console.log(pc.dim('  preview stage…'));
      const previewId = await client.createTextTo3DPreview({
        prompt,
        art_style: opts.artStyle,
        seed: opts.seed,
      });
      console.log(`  task ${previewId}`);
      let task = await client.waitForTask('text-to-3d', previewId, {
        onProgress: progressLine,
      });

      if (opts.refine) {
        console.log(pc.dim('  refine stage…'));
        const refineId = await client.createTextTo3DRefine({
          preview_task_id: previewId,
        });
        console.log(`  task ${refineId}`);
        task = await client.waitForTask('text-to-3d', refineId, {
          onProgress: progressLine,
        });
      }
      await downloadTo(client, task, opts.out);
      if (opts.optimize) {
        const passed = await optimizeFile(
          opts.out,
          opts.out.replace(/\.glb$/i, '') + '.web.glb',
          opts.profile,
        );
        process.exitCode = passed ? 0 : 1;
      }
    });

  meshy
    .command('remesh')
    .description('Retopologize a finished task (quad topology, polycount target).')
    .argument('<taskId>', 'a SUCCEEDED image-to-3d / text-to-3d task id')
    .option('--topology <t>', 'quad | triangle', 'quad')
    .option('--polycount <n>', 'target polycount', (v) => parseInt(v, 10))
    .option('-o, --out <file>', 'output GLB path', 'meshy-remeshed.glb')
    .action(async (taskId: string, opts: { topology: 'quad' | 'triangle'; polycount?: number; out: string }) => {
      const client = new MeshyClient();
      const id = await client.createRemesh({
        input_task_id: taskId, topology: opts.topology, target_polycount: opts.polycount,
      });
      console.log(`  task ${id}`);
      const task = await client.waitForTask('remesh', id, { onProgress: progressLine });
      await downloadTo(client, task, opts.out);
    });

  meshy
    .command('retexture')
    .description('Re-texture a finished task from a style prompt.')
    .argument('<taskId>', 'a SUCCEEDED task id')
    .argument('<style>', 'style prompt, e.g. "weathered bronze statue"')
    .option('--pbr', 'generate PBR maps')
    .option('-o, --out <file>', 'output GLB path', 'meshy-retextured.glb')
    .action(async (taskId: string, style: string, opts: { pbr?: boolean; out: string }) => {
      const client = new MeshyClient();
      const id = await client.createRetexture({
        input_task_id: taskId, text_style_prompt: style, enable_pbr: opts.pbr,
      });
      console.log(`  task ${id}`);
      const task = await client.waitForTask('retexture', id, { onProgress: progressLine });
      await downloadTo(client, task, opts.out);
    });

  meshy
    .command('balance')
    .description('Show remaining Meshy credits.')
    .action(async () => {
      console.log(`  ${await new MeshyClient().getBalance()} credits`);
    });

  meshy
    .command('status')
    .description('Check a task.')
    .argument('<taskId>')
    .option('--kind <kind>', 'text-to-3d | image-to-3d', 'image-to-3d')
    .action(async (taskId: string, opts: { kind: TaskKind }) => {
      const task = await new MeshyClient().getTask(opts.kind, taskId);
      console.log(JSON.stringify(task, null, 2));
    });

  meshy
    .command('download')
    .description('Download a finished task\'s GLB.')
    .argument('<taskId>')
    .option('--kind <kind>', 'text-to-3d | image-to-3d', 'image-to-3d')
    .option('-o, --out <file>', 'output path', 'meshy-output.glb')
    .action(async (taskId: string, opts: { kind: TaskKind; out: string }) => {
      const client = new MeshyClient();
      const task = await client.getTask(opts.kind, taskId);
      if (task.status !== 'SUCCEEDED') {
        throw new Error(`Task is ${task.status} (${task.progress}%), nothing to download yet.`);
      }
      await downloadTo(client, task, opts.out);
    });
}
