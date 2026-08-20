/** Task families have different endpoint roots/versions on the Meshy API. */
export type TaskKind = 'text-to-3d' | 'image-to-3d' | 'remesh' | 'retexture';

export type TaskStatus =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELED';

export interface ModelUrls {
  glb?: string;
  fbx?: string;
  usdz?: string;
  obj?: string;
  mtl?: string;
}

export interface MeshyTask {
  id: string;
  status: TaskStatus;
  /** 0-100 */
  progress: number;
  model_urls?: ModelUrls;
  texture_urls?: Array<Record<string, string>>;
  thumbnail_url?: string;
  task_error?: { message?: string } | null;
  created_at?: number;
  started_at?: number;
  finished_at?: number;
}

export interface TextTo3DPreviewParams {
  prompt: string;
  art_style?: 'realistic' | 'sculpture';
  /** Reproducibility — pass a fixed seed for deterministic re-runs. */
  seed?: number;
  topology?: 'quad' | 'triangle';
  target_polycount?: number;
  symmetry_mode?: 'off' | 'auto' | 'on';
}

export interface TextTo3DRefineParams {
  preview_task_id: string;
  enable_pbr?: boolean;
  texture_prompt?: string;
}

export interface ImageTo3DParams {
  /** Public URL or data URI. */
  image_url: string;
  ai_model?: string;
  topology?: 'quad' | 'triangle';
  target_polycount?: number;
  symmetry_mode?: 'off' | 'auto' | 'on';
  should_remesh?: boolean;
  should_texture?: boolean;
  enable_pbr?: boolean;
  texture_prompt?: string;
}

export interface WaitOptions {
  /** Base polling interval; backs off on 429. Default 5000ms. */
  pollIntervalMs?: number;
  /** Give up after this long. Default 20 minutes. */
  timeoutMs?: number;
  onProgress?: (task: MeshyTask) => void;
}

export interface RemeshParams {
  /** Finished task to remesh (or provide model_url). */
  input_task_id?: string;
  model_url?: string;
  target_formats?: Array<'glb' | 'fbx' | 'obj' | 'usdz' | 'stl' | 'blend'>;
  topology?: 'quad' | 'triangle';
  target_polycount?: number;
  resize_height?: number;
  origin_at?: 'bottom' | 'center';
}

export interface RetextureParams {
  /** Finished task to retexture (or provide model_url). */
  input_task_id?: string;
  model_url?: string;
  /** Describe the new look, e.g. "weathered bronze statue". */
  text_style_prompt?: string;
  image_style_url?: string;
  enable_original_uv?: boolean;
  enable_pbr?: boolean;
}
