/**
 * fal.ai client for open-weight image-to-3D models (Hunyuan3D, TRELLIS,
 * TripoSR). Same queue-poll-download shape as the Meshy client, so the
 * worker and studio treat every generation provider identically.
 *
 * Schema tolerance: fal model outputs differ per model and drift over
 * time, so results are deep-scanned for the first .glb URL instead of
 * hardcoding response paths.
 */

export const FAL_MODELS = {
  /** Tencent Hunyuan3D 2 — highest quality of the open trio. */
  hunyuan: 'fal-ai/hunyuan3d/v2',
  /** Microsoft TRELLIS — strong quality/speed balance. */
  trellis: 'fal-ai/trellis',
  /** TripoSR — fastest and cheapest, lighter on detail. */
  triposr: 'fal-ai/triposr',
} as const;

export type FalModelKey = keyof typeof FAL_MODELS;

export class FalError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'FalError';
  }
}

export interface FalClientOptions {
  /** Defaults to process.env.FAL_KEY. */
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/** Depth-first scan for the first URL ending in .glb anywhere in a payload. */
export function findGlbUrl(value: unknown): string | null {
  if (typeof value === 'string') {
    return /^https?:\/\/\S+\.glb(\?\S*)?$/i.test(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findGlbUrl(item);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const hit = findGlbUrl((value as Record<string, unknown>)[key]);
      if (hit) return hit;
    }
  }
  return null;
}

export class FalClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(opts: FalClientOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.FAL_KEY;
    if (!apiKey) {
      throw new FalError(
        'Missing fal.ai API key. Set FAL_KEY (keys: https://fal.ai/dashboard/keys) ' +
        'or pass { apiKey } explicitly.',
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://queue.fal.run').replace(/\/$/, '');
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(this.baseUrl + path, {
      method,
      headers: {
        authorization: `Key ${this.apiKey}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
    if (!res.ok) {
      const detail = (json as { detail?: unknown })?.detail;
      throw new FalError(
        typeof detail === 'string' ? detail : `fal ${method} ${path} failed with HTTP ${res.status}`,
        res.status,
      );
    }
    return json as T;
  }

  /** Submit an image (data URI or URL). Returns the queue request id. */
  async submit(model: string, imageUrl: string): Promise<string> {
    // Models disagree on the input key; send the common aliases together —
    // unknown keys are ignored.
    const res = await this.request<{ request_id?: string }>('POST', `/${model}`, {
      image_url: imageUrl,
      input_image_url: imageUrl,
      input_image_urls: [imageUrl],
    });
    if (!res.request_id) throw new FalError('fal did not return a request id');
    return res.request_id;
  }

  async status(model: string, requestId: string): Promise<{
    status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | string;
    queuePosition: number | null;
  }> {
    const res = await this.request<{ status: string; queue_position?: number }>(
      'GET', `/${model}/requests/${requestId}/status`,
    );
    return { status: res.status, queuePosition: res.queue_position ?? null };
  }

  /** Fetch the finished result and extract its GLB URL. */
  async resultGlbUrl(model: string, requestId: string): Promise<string> {
    const res = await this.request<unknown>('GET', `/${model}/requests/${requestId}`);
    const url = findGlbUrl(res);
    if (!url) {
      throw new FalError(
        `No .glb in the ${model} result — the model may output a different format. ` +
        `Top-level keys: ${Object.keys((res as object) ?? {}).join(', ')}`,
      );
    }
    return url;
  }

  async downloadGlb(url: string): Promise<Uint8Array> {
    const res = await this.fetch(url);
    if (!res.ok) throw new FalError(`model download failed: HTTP ${res.status}`, res.status);
    return new Uint8Array(await res.arrayBuffer());
  }
}
