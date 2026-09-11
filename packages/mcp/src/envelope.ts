/**
 * Common response envelope for every tool:
 *   { ok, summary, duration_ms, errors[], data }
 * `errors` carries every diagnostic (error / warning / info) with a stable
 * code and a prim_path. `ok` is false only when the tool could not run
 * (unreadable input, bad arguments, provider failure) — a validated asset
 * with errors in it is still ok:true with errors listed.
 *
 * Timing and diagnostics accumulated while a handler runs are kept in an
 * AsyncLocalStorage context, so handlers just call `reply()` / `note()`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { countBySeverity, diag, recordUsage, sortDiagnostics, type Diagnostic, type DiagnosticCode } from '@glbforge/core';
import type { ImageBlock } from './preview.js';

/** One id per server process: every call from the same client conversation shares it (usage lineage rule (a)). */
export const SESSION_ID = randomUUID();

export interface Envelope {
  ok: boolean;
  summary: string;
  duration_ms: number;
  errors: Diagnostic[];
  data: Record<string, unknown>;
}

interface CallContext { start: number; errors: Diagnostic[]; tool: string }

const als = new AsyncLocalStorage<CallContext>();

/** Run a tool handler inside a call context; exceptions become ok:false envelopes. Records an opt-in usage event afterwards. */
export function withContext<T>(tool: string, fn: () => Promise<T>, args: Record<string, unknown> = {}): Promise<T | ReturnType<typeof failure>> {
  return als.run({ start: performance.now(), errors: [], tool }, async () => {
    let result: T | ReturnType<typeof failure>;
    try {
      result = await fn();
    } catch (err) {
      result = failure(err, tool);
    }
    await recordCall(tool, args, result as { structuredContent?: Record<string, unknown> });
    return result;
  });
}

/** Usage event from what the wrapper can see: the path args and what the handler put in `data` (sha256, lineage). Never throws. */
async function recordCall(tool: string, args: Record<string, unknown>, result: { structuredContent?: Record<string, unknown> }): Promise<void> {
  try {
    const env = result.structuredContent as { ok?: boolean; duration_ms?: number; data?: Record<string, unknown> } | undefined;
    const data = env?.data ?? {};
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    const path = str(args.after) ?? str(args.path) ?? str(args.input) ?? str(args.candidate) ?? str(args.dir) ?? null;
    const lineageData = data.lineage as { before_sha256?: string; after_sha256?: string } | undefined;
    const sha256 = str(data.sha256) ?? str(lineageData?.after_sha256) ?? str((data.after as { sha256?: string } | undefined)?.sha256) ?? null;
    const edge = lineageData?.before_sha256 && lineageData?.after_sha256 ? { from: lineageData.before_sha256, to: lineageData.after_sha256 } : null;
    await recordUsage({ tool, surface: 'mcp', session: SESSION_ID, path, sha256, edge, lineage: str(args.lineage), duration_ms: env?.duration_ms ?? 0, ok: env?.ok ?? false });
  } catch { /* usage must never affect the tool */ }
}

/** Attach a diagnostic to the current call (e.g. a mutation the caller did not ask for). */
export function note(d: Diagnostic): void {
  const ctx = als.getStore();
  if (ctx) ctx.errors.push(d);
}

export function noteAll(list: Diagnostic[]): void {
  for (const d of list) note(d);
}

const durationMs = () => {
  const ctx = als.getStore();
  return ctx ? Math.round(performance.now() - ctx.start) : 0;
};

/** Dedupe by code+path+property+message, keep severity order. */
function collect(extra: Diagnostic[] = []): Diagnostic[] {
  const ctx = als.getStore();
  const all = [...(ctx?.errors ?? []), ...extra];
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of all) {
    const key = `${d.code}|${d.prim_path}|${d.property ?? ''}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return sortDiagnostics(out);
}

type TextBlock = { type: 'text'; text: string };

export interface ReplyOptions {
  summary: string;
  errors?: Diagnostic[];
  image?: ImageBlock | null;
  ok?: boolean;
}

/** Build the envelope and the MCP result (JSON text + structuredContent + optional image). */
export function reply(data: Record<string, unknown>, opts: ReplyOptions) {
  const errors = collect(opts.errors);
  const env: Envelope = { ok: opts.ok ?? true, summary: opts.summary, duration_ms: durationMs(), errors, data };
  const content: Array<TextBlock | ImageBlock> = [{ type: 'text', text: JSON.stringify(env) }];
  if (opts.image) content.push(opts.image);
  return { content, structuredContent: env as unknown as Record<string, unknown> };
}

/** ok:false envelope for a thrown error; `isError` is set so clients surface it, structuredContent still carries the envelope. */
export function failure(err: unknown, tool: string) {
  const e = err as { message?: string; code?: string; diagnostics?: Diagnostic[] };
  const message = e?.message ?? String(err);
  const code = (e?.code && e.code in CODES ? e.code : 'TOOL_ERROR') as DiagnosticCode;
  const d = diag(code, '', `${tool}: ${message}`);
  const errors = collect([d, ...(e?.diagnostics ?? [])]);
  const env: Envelope = { ok: false, summary: `${tool} failed: ${message}`, duration_ms: durationMs(), errors, data: {} };
  return { content: [{ type: 'text' as const, text: JSON.stringify(env) }], structuredContent: env as unknown as Record<string, unknown>, isError: true };
}

const CODES: Record<string, true> = { FILE_NOT_FOUND: true, FILE_UNREADABLE: true, FORMAT_UNSUPPORTED: true, USDZ_NO_LAYER: true, TOOL_ERROR: true };

/** "3 meshes, 1 skeleton, 2 warnings" style tail for summaries. */
export function severityTail(errors: Diagnostic[]): string {
  const c = countBySeverity(errors);
  const parts: string[] = [];
  if (c.errors) parts.push(`${c.errors} error${c.errors > 1 ? 's' : ''}`);
  if (c.warnings) parts.push(`${c.warnings} warning${c.warnings > 1 ? 's' : ''}`);
  if (!parts.length) parts.push(c.info ? `${c.info} info` : 'clean');
  return parts.join(', ');
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : /(sh|ch|s|x)$/.test(word) ? 'es' : 's'}`;
