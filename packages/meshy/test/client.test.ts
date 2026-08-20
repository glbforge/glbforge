import { describe, expect, it, vi } from 'vitest';
import { MeshyClient, MeshyError, type MeshyTask } from '../src/index.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function makeClient(responses: Array<Response | (() => Response)>) {
  const fetch = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('mock fetch exhausted');
    return typeof next === 'function' ? next() : next;
  });
  return { client: new MeshyClient({ apiKey: 'msy_test', fetch }), fetch };
}

describe('MeshyClient', () => {
  it('requires an API key', () => {
    const saved = process.env.MESHY_API_KEY;
    delete process.env.MESHY_API_KEY;
    expect(() => new MeshyClient()).toThrow(/MESHY_API_KEY/);
    if (saved) process.env.MESHY_API_KEY = saved;
  });

  it('creates an image-to-3d task and sends auth header', async () => {
    const { client, fetch } = makeClient([json({ result: 'task_123' })]);
    const id = await client.createImageTo3D({ image_url: 'data:image/png;base64,x' });
    expect(id).toBe('task_123');
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.meshy.ai/openapi/v1/image-to-3d');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer msy_test');
  });

  it('polls to success and reports progress', async () => {
    const running: MeshyTask = { id: 't1', status: 'IN_PROGRESS', progress: 40 };
    const done: MeshyTask = {
      id: 't1', status: 'SUCCEEDED', progress: 100,
      model_urls: { glb: 'https://assets.meshy.ai/t1.glb' },
    };
    const { client } = makeClient([json(running), json(done)]);
    const seen: number[] = [];
    const task = await client.waitForTask('text-to-3d', 't1', {
      pollIntervalMs: 1,
      onProgress: (t) => seen.push(t.progress),
    });
    expect(task.status).toBe('SUCCEEDED');
    expect(seen).toEqual([40, 100]);
  });

  it('backs off on 429 and recovers', async () => {
    const done: MeshyTask = { id: 't2', status: 'SUCCEEDED', progress: 100 };
    const { client, fetch } = makeClient([
      json({ message: 'rate limited' }, 429),
      json(done),
    ]);
    const task = await client.waitForTask('text-to-3d', 't2', { pollIntervalMs: 1 });
    expect(task.status).toBe('SUCCEEDED');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('surfaces task failure with the API message', async () => {
    const failed: MeshyTask = {
      id: 't3', status: 'FAILED', progress: 10,
      task_error: { message: 'NSFW content detected' },
    };
    const { client } = makeClient([json(failed)]);
    await expect(
      client.waitForTask('image-to-3d', 't3', { pollIntervalMs: 1 }),
    ).rejects.toThrow(/NSFW content detected/);
  });

  it('throws MeshyError with status on non-2xx create', async () => {
    const { client } = makeClient([json({ message: 'invalid api key' }, 401)]);
    await expect(client.createImageTo3D({ image_url: 'x' })).rejects.toMatchObject({
      name: 'MeshyError',
      status: 401,
      message: 'invalid api key',
    });
  });

  it('downloadModel picks the requested format or explains what exists', async () => {
    const task: MeshyTask = {
      id: 't4', status: 'SUCCEEDED', progress: 100,
      model_urls: { glb: 'https://assets.meshy.ai/t4.glb' },
    };
    const bytes = new Uint8Array([1, 2, 3]);
    const { client } = makeClient([new Response(bytes)]);
    expect(await client.downloadModel(task)).toEqual(bytes);
    await expect(client.downloadModel(task, 'fbx')).rejects.toThrow(/available: glb/);
  });
});

describe('remesh / retexture / balance', () => {
  it('creates a remesh task against the v1 endpoint', async () => {
    const { client, fetch } = makeClient([json({ result: 'rm_1' })]);
    const id = await client.createRemesh({ input_task_id: 't1', topology: 'quad', target_polycount: 30000 });
    expect(id).toBe('rm_1');
    expect((fetch.mock.calls[0] as [string])[0]).toBe('https://api.meshy.ai/openapi/v1/remesh');
  });

  it('creates a retexture task and polls it under the retexture kind', async () => {
    const done = { id: 'rt_1', status: 'SUCCEEDED', progress: 100 };
    const { client, fetch } = makeClient([json({ result: 'rt_1' }), json(done)]);
    const id = await client.createRetexture({ input_task_id: 't1', text_style_prompt: 'bronze' });
    const task = await client.waitForTask('retexture', id, { pollIntervalMs: 1 });
    expect(task.status).toBe('SUCCEEDED');
    expect((fetch.mock.calls[1] as [string])[0]).toBe('https://api.meshy.ai/openapi/v1/retexture/rt_1');
  });

  it('reads the credit balance', async () => {
    const { client } = makeClient([json({ balance: 420 })]);
    expect(await client.getBalance()).toBe(420);
  });
});
