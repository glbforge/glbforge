import type {
  ImageTo3DParams,
  MeshyTask,
  TaskKind,
  TextTo3DPreviewParams,
  TextTo3DRefineParams,
  WaitOptions,
} from './types.js';

export class MeshyError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'MeshyError';
  }
}

export interface MeshyClientOptions {
  /** Defaults to process.env.MESHY_API_KEY. */
  apiKey?: string;
  baseUrl?: string;
  /** Injectable for tests. */
  fetch?: typeof globalThis.fetch;
}

/** Endpoint paths per task family (they live under different API versions). */
const TASK_PATHS: Record<TaskKind, string> = {
  'text-to-3d': '/openapi/v2/text-to-3d',
  'image-to-3d': '/openapi/v1/image-to-3d',
};

export class MeshyClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(opts: MeshyClientOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.MESHY_API_KEY;
    if (!apiKey) {
      throw new MeshyError(
        'Missing Meshy API key. Set MESHY_API_KEY (e.g. in .env — see .env.example) ' +
          'or pass { apiKey } explicitly. Keys: https://app.meshy.ai/settings/api',
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.meshy.ai').replace(/\/$/, '');
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }

    if (!res.ok) {
      const message =
        (json as { message?: string } | undefined)?.message ??
        `Meshy API ${method} ${path} failed with HTTP ${res.status}`;
      throw new MeshyError(message, res.status, json);
    }
    return json as T;
  }

  /** Stage 1 of text-to-3D: geometry preview (fast, cheap). */
  async createTextTo3DPreview(params: TextTo3DPreviewParams): Promise<string> {
    const res = await this.request<{ result: string }>(
      'POST',
      TASK_PATHS['text-to-3d'],
      { mode: 'preview', ...params },
    );
    return res.result;
  }

  /** Stage 2 of text-to-3D: texture the accepted preview. */
  async createTextTo3DRefine(params: TextTo3DRefineParams): Promise<string> {
    const res = await this.request<{ result: string }>(
      'POST',
      TASK_PATHS['text-to-3d'],
      { mode: 'refine', ...params },
    );
    return res.result;
  }

  async createImageTo3D(params: ImageTo3DParams): Promise<string> {
    const res = await this.request<{ result: string }>(
      'POST',
      TASK_PATHS['image-to-3d'],
      params,
    );
    return res.result;
  }

  async getTask(kind: TaskKind, id: string): Promise<MeshyTask> {
    return this.request<MeshyTask>('GET', `${TASK_PATHS[kind]}/${id}`);
  }

  /**
   * Poll until the task reaches a terminal state. Backs off on 429 and
   * transient network errors rather than failing a 10-minute generation
   * over one dropped poll.
   */
  async waitForTask(
    kind: TaskKind,
    id: string,
    opts: WaitOptions = {},
  ): Promise<MeshyTask> {
    const interval = opts.pollIntervalMs ?? 5000;
    const deadline = Date.now() + (opts.timeoutMs ?? 20 * 60 * 1000);
    let backoff = interval;

    while (true) {
      if (Date.now() > deadline) {
        throw new MeshyError(`Timed out waiting for ${kind} task ${id}`);
      }
      let task: MeshyTask | null = null;
      try {
        task = await this.getTask(kind, id);
        backoff = interval; // healthy poll resets backoff
      } catch (err) {
        const transient =
          err instanceof MeshyError &&
          (err.status === 429 || (err.status ?? 0) >= 500);
        if (!transient) throw err;
        backoff = Math.min(backoff * 2, 60_000);
      }

      if (task) {
        opts.onProgress?.(task);
        if (task.status === 'SUCCEEDED') return task;
        if (task.status === 'FAILED' || task.status === 'CANCELED') {
          throw new MeshyError(
            `Task ${id} ${task.status.toLowerCase()}: ${task.task_error?.message ?? 'no error message'}`,
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  /** Download a generated model; format defaults to glb. */
  async downloadModel(
    task: MeshyTask,
    format: keyof NonNullable<MeshyTask['model_urls']> = 'glb',
  ): Promise<Uint8Array> {
    const url = task.model_urls?.[format];
    if (!url) {
      throw new MeshyError(
        `Task ${task.id} has no ${format} URL (available: ${Object.keys(task.model_urls ?? {}).join(', ') || 'none'})`,
      );
    }
    const res = await this.fetch(url);
    if (!res.ok) {
      throw new MeshyError(`Model download failed: HTTP ${res.status}`, res.status);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
}
