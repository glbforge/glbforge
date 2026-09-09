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
import { countBySeverity, diag, sortDiagnostics, type Diagnostic, type DiagnosticCode } from '@glbforge/core';
import type { ImageBlock } from './preview.js';

export interface Envelope {
  ok: boolean;
  summary: string;
  duration_ms: number;
  errors: Diagnostic[];
  data: Record<string, unknown>;
}

interface CallContext { start: number; errors: Diagnostic[]; tool: string }

const als = new AsyncLocalStorage<CallContext>();

/** Run a tool handler inside a call context; exceptions become ok:false envelopes. */
export function withContext<T>(tool: string, fn: () => Promise<T>): Promise<T | ReturnType<typeof failure>> {
  return als.run({ start: performance.now(), errors: [], tool }, async () => {
    try {
      return await fn();
    } catch (err) {
      return failure(err, tool);
    }
  });
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

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
