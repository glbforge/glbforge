import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal .env loader: KEY=VALUE lines, # comments, optional quotes.
 * Never overrides variables already set in the environment, and never
 * logs values. Searched in the current working directory only.
 */
export function loadDotEnv(dir = process.cwd()): void {
  let text: string;
  try {
    text = readFileSync(join(dir, '.env'), 'utf8');
  } catch {
    return; // no .env — fine, the environment may already be configured
  }
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    const [, key, raw] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, '');
  }
}
