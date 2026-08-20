import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import express from 'express';
import { Logger } from '@gltf-transform/core';
import {
  analyze,
  createNodeIO,
  extrudeImage,
  getProfile,
  optimize,
  PROFILES,
  toStl,
  type AnalysisResult,
} from '@glbforge/core';
import { FAL_MODELS, FalClient, MeshyClient, type TaskKind } from '@glbforge/meshy';

interface Asset {
  id: string;
  name: string;
  bytes: Uint8Array;
  report: AnalysisResult;
  /** Set on optimized variants: the asset they were derived from. */
  parentId?: string;
  steps?: string[];
}

const assets = new Map<string, Asset>();
let nextId = 1;

async function ingest(
  name: string,
  bytes: Uint8Array,
  profileName: string,
  parentId?: string,
  steps?: string[],
): Promise<Asset> {
  const io = await createNodeIO();
  const doc = await io.readBinary(bytes);
  const report = analyze(doc, {
    profile: getProfile(profileName),
    filePath: name,
    fileBytes: bytes.byteLength,
  });
  const asset: Asset = { id: String(nextId++), name, bytes, report, parentId, steps };
  assets.set(asset.id, asset);
  return asset;
}

const summary = (a: Asset) => ({
  id: a.id,
  name: a.name,
  bytes: a.bytes.byteLength,
  score: a.report.score,
  passed: a.report.passed,
  triangles: a.report.geometry.triangles,
  parentId: a.parentId ?? null,
  steps: a.steps ?? null,
});

export async function startUiServer(opts: {
  port: number;
  preload: string[];
  profile: string;
}): Promise<void> {
  const app = express();
  app.use(express.json());
  // Parse raw bodies regardless of Content-Type: browsers send none for
  // ArrayBuffer fetch bodies, and body-parser skips typeless requests.
  const raw = express.raw({ type: () => true, limit: '1gb' });
  const requireBody = (req: express.Request, res: express.Response): boolean => {
    if (req.body?.length > 0) return true;
    res.status(400).json({ error: 'Empty upload — the request body had no bytes. Refresh the Studio tab if it has been open a while.' });
    return false;
  };

  app.get('/api/profiles', (_req, res) => res.json(PROFILES));
  app.get('/api/assets', (_req, res) => res.json([...assets.values()].map(summary)));
  app.get('/api/assets/:id', (req, res) => {
    const asset = assets.get(req.params.id);
    if (!asset) return res.status(404).json({ error: 'no such asset' });
    res.json({ ...summary(asset), report: asset.report });
  });
  app.get('/api/assets/:id/file', (req, res) => {
    const asset = assets.get(req.params.id);
    if (!asset) return res.status(404).end();
    res.type('model/gltf-binary').send(Buffer.from(asset.bytes));
  });

  app.post('/api/assets', raw, async (req, res) => {
    if (!requireBody(req, res)) return;
    try {
      const name = String(req.query.name ?? 'asset.glb');
      const profile = String(req.query.profile ?? 'mobile-hero');
      const asset = await ingest(name, new Uint8Array(req.body), profile);
      res.json({ ...summary(asset), report: asset.report });
    } catch (err) {
      console.error(`  [api] ${req.method} ${req.path}:`, err instanceof Error ? err.message : err);
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/assets/:id/analyze', async (req, res) => {
    const asset = assets.get(req.params.id);
    if (!asset) return res.status(404).json({ error: 'no such asset' });
    const io = await createNodeIO();
    const doc = await io.readBinary(asset.bytes);
    asset.report = analyze(doc, {
      profile: getProfile(String(req.body?.profile ?? 'mobile-hero')),
      filePath: asset.name,
      fileBytes: asset.bytes.byteLength,
    });
    res.json({ ...summary(asset), report: asset.report });
  });

  app.post('/api/assets/:id/optimize', async (req, res) => {
    try {
      const asset = assets.get(req.params.id);
      if (!asset) return res.status(404).json({ error: 'no such asset' });
      const { profile = 'mobile-hero', ktx2 = false, targetTriangles } = req.body ?? {};
      const io = await createNodeIO();
      const doc = await io.readBinary(asset.bytes);
      doc.setLogger(new Logger(Logger.Verbosity.ERROR));
      const result = await optimize(doc, {
        profile: getProfile(profile),
        textureFormat: ktx2 ? 'ktx2' : 'webp',
        targetTriangles,
      });
      const outBytes = await io.writeBinary(doc);
      const variant = await ingest(
        asset.name.replace(/\.glb$/i, '') + '.web.glb',
        outBytes, profile, asset.id, result.steps,
      );
      res.json({ ...summary(variant), report: variant.report });
    } catch (err) {
      console.error(`  [api] ${req.method} ${req.path}:`, err instanceof Error ? err.message : err);
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/extrude', raw, async (req, res) => {
    if (!requireBody(req, res)) return;
    try {
      const name = String(req.query.name ?? 'image.png');
      const profile = String(req.query.profile ?? 'mobile-hero');
      const bevel = Number(req.query.bevel ?? 0);
      const depth = req.query.depth ? Number(req.query.depth) : undefined;
      const layers = req.query.layers ? Number(req.query.layers) : undefined;
      const pillow = req.query.pillow ? Number(req.query.pillow) : undefined;
      const emboss = req.query.emboss ? Number(req.query.emboss) : undefined;
      const preset = req.query.preset ? String(req.query.preset) as 'enamel' | 'chrome' | 'neon' | 'acrylic' | 'rubber' : undefined;
      const { doc } = await extrudeImage(new Uint8Array(req.body), { bevel, depth, layers, pillow, emboss, preset });
      const io = await createNodeIO();
      const outBytes = await io.writeBinary(doc);
      const asset = await ingest(name.replace(/\.[a-z0-9]+$/i, '') + '.glb', outBytes, profile);
      res.json({ ...summary(asset), report: asset.report });
    } catch (err) {
      console.error(`  [api] ${req.method} ${req.path}:`, err instanceof Error ? err.message : err);
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/assets/:id/stl', async (req, res) => {
    try {
      const asset = assets.get(req.params.id);
      if (!asset) return res.status(404).end();
      const io = await createNodeIO();
      const doc = await io.readBinary(asset.bytes);
      const { stl } = toStl(doc, { targetSizeMm: Number(req.query.size ?? 80) });
      res
        .type('application/octet-stream')
        .set('Content-Disposition', `attachment; filename="${asset.name.replace(/\.glb$/i, '')}.stl"`)
        .send(Buffer.from(stl));
    } catch (err) {
      console.error(`  [api] ${req.method} ${req.path}:`, err instanceof Error ? err.message : err);
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- Meshy bridge (active only when a key is configured) ---
  app.get('/api/meshy/available', (_req, res) =>
    res.json({
      available: !!process.env.MESHY_API_KEY || !!process.env.FAL_KEY,
      generators: {
        meshy: !!process.env.MESHY_API_KEY,
        ...(process.env.FAL_KEY ? { hunyuan: true, trellis: true, triposr: true } : {}),
      },
    }),
  );
  app.post('/api/meshy/image', raw, async (req, res) => {
    if (!requireBody(req, res)) return;
    try {
      const mime = String(req.query.mime ?? 'image/png');
      const provider = String(req.query.provider ?? 'meshy');
      const dataUri = `data:${mime};base64,${Buffer.from(req.body).toString('base64')}`;
      if (provider !== 'meshy') {
        const model = FAL_MODELS[provider as keyof typeof FAL_MODELS];
        if (!model) return res.status(400).json({ error: `unknown provider ${provider}` });
        const requestId = await new FalClient().submit(model, dataUri);
        return res.json({ taskId: requestId, kind: `fal:${model}` });
      }
      const client = new MeshyClient();
      const taskId = await client.createImageTo3D({
        image_url: dataUri,
        should_texture: req.query.texture !== 'false',
        enable_pbr: req.query.pbr === 'true',
      });
      res.json({ taskId, kind: 'image-to-3d' });
    } catch (err) {
      console.error(`  [api] ${req.method} ${req.path}:`, err instanceof Error ? err.message : err);
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  // Query-based (kinds like 'fal:fal-ai/trellis' contain slashes).
  app.get('/api/meshy/task2', async (req, res) => {
    try {
      const kind = String(req.query.kind), id = String(req.query.id);
      if (kind.startsWith('fal:')) {
        const st = await new FalClient().status(kind.slice(4), id);
        res.json({
          status: st.status === 'COMPLETED' ? 'SUCCEEDED' : 'IN_PROGRESS',
          progress: st.status === 'COMPLETED' ? 100 : st.status === 'IN_PROGRESS' ? 50 : 5,
          error: null,
        });
        return;
      }
      const task = await new MeshyClient().getTask(kind as TaskKind, id);
      res.json({ status: task.status, progress: task.progress, error: task.task_error?.message ?? null });
    } catch (err) {
      console.error(`  [api] ${req.method} ${req.path}:`, err instanceof Error ? err.message : err);
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post('/api/meshy/import2', async (req, res) => {
    try {
      const kind = String(req.query.kind), id = String(req.query.id);
      let bytes: Uint8Array;
      if (kind.startsWith('fal:')) {
        const fal = new FalClient();
        bytes = await fal.downloadGlb(await fal.resultGlbUrl(kind.slice(4), id));
      } else {
        const client = new MeshyClient();
        bytes = await client.downloadModel(await client.getTask(kind as TaskKind, id), 'glb');
      }
      const asset = await ingest(`gen-${id.slice(0, 8)}.glb`, bytes, 'mobile-hero');
      res.json({ ...summary(asset), report: asset.report });
    } catch (err) {
      console.error(`  [api] ${req.method} ${req.path}:`, err instanceof Error ? err.message : err);
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  // Legacy path-based routes kept for older clients (Meshy kinds only).
  app.get('/api/meshy/tasks/:kind/:id', async (req, res) => {
    try {
      const task = await new MeshyClient().getTask(req.params.kind as TaskKind, req.params.id);
      res.json({ id: task.id, status: task.status, progress: task.progress, error: task.task_error?.message ?? null });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post('/api/meshy/tasks/:kind/:id/import', async (req, res) => {
    try {
      const client = new MeshyClient();
      const task = await client.getTask(req.params.kind as TaskKind, req.params.id);
      const bytes = await client.downloadModel(task, 'glb');
      const asset = await ingest(`meshy-${task.id.slice(0, 8)}.glb`, bytes, 'mobile-hero');
      res.json({ ...summary(asset), report: asset.report });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- static studio bundle ---
  const require = createRequire(import.meta.url);
  let staticDir: string | null = null;
  try {
    staticDir = join(dirname(require.resolve('@glbforge/studio/package.json')), 'dist');
  } catch { /* studio not installed — API-only mode */ }
  if (staticDir) {
    app.use(express.static(staticDir));
    // SPA fallback (Express 5: no bare '*' routes — use a middleware).
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api/')) {
        res.sendFile(join(staticDir!, 'index.html'));
      } else next();
    });
  }

  for (const file of opts.preload) {
    try {
      const bytes = new Uint8Array(await readFile(file));
      if (extname(file).toLowerCase() === '.glb') {
        await ingest(file.split('/').pop()!, bytes, opts.profile);
      }
    } catch (err) {
      console.error(`  preload failed for ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  await new Promise<void>((resolve) => {
    createServer(app).listen(opts.port, '127.0.0.1', resolve);
  });
  console.log(`  GLBForge Studio: http://localhost:${opts.port}`);
}
