/**
 * Directory audit: analyze every GLB under a directory against one budget.
 * Node-only (filesystem); shared by the CLI (`glbforge audit`), the MCP
 * `audit_directory` tool, and `glbforge init`'s `glb:check` script.
 */
import { Logger } from '@gltf-transform/core';
import { analyze } from './analyze/index.js';
import { createNodeIO } from './io.js';
import type { Profile } from './types.js';

export interface AuditRow {
  path: string;
  score?: number;
  passed?: boolean;
  triangles?: number;
  bytes?: number;
  topFinding?: string | null;
  error?: string;
}

export interface AuditResult {
  profile: string;
  scanned: number;
  /** Files beyond the `limit` that were not analyzed. */
  truncated: number;
  failing: string[];
  results: AuditRow[];
}

export interface AuditOptions {
  profile: Profile;
  recursive?: boolean;
  /** Max files to analyze (default 50). */
  limit?: number;
  /** Max recursion depth (default 4). */
  maxDepth?: number;
}

/** GLB outputs GLBForge itself writes; never audited as inputs. */
export const OUTPUT_PATTERN = /\.(web(\.lod\d+)?|forge|gen)\.glb$/i;

export async function listGlbs(dir: string, opts: { recursive?: boolean; maxDepth?: number } = {}): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const files: string[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (opts.recursive && depth < (opts.maxDepth ?? 4) && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
          await walk(full, depth + 1);
        }
      } else if (/\.glb$/i.test(entry.name) && !OUTPUT_PATTERN.test(entry.name)) {
        files.push(full);
      }
    }
  };
  await walk(dir, 0);
  return files.sort();
}

export async function auditDirectory(dir: string, opts: AuditOptions): Promise<AuditResult> {
  const { readFile } = await import('node:fs/promises');
  const io = await createNodeIO();
  const files = await listGlbs(dir, opts);
  const limit = opts.limit ?? 50;
  const results: AuditRow[] = [];
  for (const file of files.slice(0, limit)) {
    try {
      const bytes = await readFile(file);
      const doc = await io.readBinary(new Uint8Array(bytes));
      doc.setLogger(new Logger(Logger.Verbosity.ERROR));
      const r = analyze(doc, { profile: opts.profile, topology: false, filePath: file, fileBytes: bytes.byteLength });
      results.push({
        path: file, score: r.score, passed: r.passed,
        triangles: r.geometry.triangles, bytes: bytes.byteLength,
        topFinding: r.findings.find((f) => f.severity === 'error')?.ruleId ?? r.findings[0]?.ruleId ?? null,
      });
    } catch (err) {
      results.push({ path: file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return {
    profile: opts.profile.name,
    scanned: results.length,
    truncated: Math.max(0, files.length - limit),
    failing: results.filter((r) => r.passed === false).map((r) => r.path),
    results,
  };
}
