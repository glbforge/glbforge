#!/usr/bin/env node
/**
 * Renders the GLBForge PR comment from a directory of `glbforge analyze
 * --json` results (one file per analyzed asset).
 * Usage: report.mjs <dir> <profileName>
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, profile = 'mobile-hero'] = process.argv.slice(2);

const mb = (bytes) => (bytes / 1048576).toFixed(1) + 'MB';
const num = (value) => value.toLocaleString('en-US');

const results = readdirSync(dir)
  .filter((file) => file.endsWith('.json'))
  .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')))
  .sort((a, b) => (a.file?.path ?? '').localeCompare(b.file?.path ?? ''));

const lines = [];
lines.push(`## 📦 GLBForge report — \`${profile}\` budget`);
lines.push('');
lines.push('| Asset | Score | Verdict | Triangles | Draw calls | File | GPU mem |');
lines.push('|---|---|---|---|---|---|---|');

for (const r of results) {
  const path = r.file?.path ?? '(unknown)';
  if (r.lfsPointer) {
    lines.push(`| \`${path}\` | — | ⚠️ LFS pointer | — | — | — | — |`);
    continue;
  }
  if (r.error) {
    lines.push(`| \`${path}\` | — | ❌ failed to analyze | — | — | — | — |`);
    continue;
  }
  const verdict = r.passed ? '✅ within budget' : '🔴 over budget';
  lines.push(
    `| \`${path}\` | **${r.score}**/100 | ${verdict} | ${num(r.geometry.triangles)} | ~${r.geometry.drawCallEstimate} | ${mb(r.file.bytes)} | ${mb(r.textureVramTotal)} |`,
  );
}

for (const r of results) {
  const path = r.file?.path ?? '(unknown)';
  if (r.lfsPointer) {
    lines.push('', `> ⚠️ \`${path}\` is a git-LFS pointer — add \`lfs: true\` to \`actions/checkout\` so GLBForge can read the real file.`);
    continue;
  }
  if (r.error) {
    lines.push('', `> ❌ \`${path}\`: ${String(r.error).slice(0, 300)}`);
    continue;
  }
  if (!r.findings?.length) continue;
  lines.push('');
  lines.push(`<details><summary><b>${path}</b> — ${r.findings.length} finding(s)</summary>`);
  lines.push('');
  for (const f of r.findings) {
    const icon = { error: '🔴', warn: '🟡', info: 'ℹ️' }[f.severity] ?? '•';
    lines.push(`- ${icon} **\`${f.ruleId}\`** — ${f.message}`);
    if (f.suggestion) lines.push(`  - ↳ ${f.suggestion}`);
  }
  lines.push('');
  lines.push('</details>');
}

lines.push('');
lines.push(`<sub>Fix locally: \`npx glbforge optimize <file> --profile ${profile}\` · <a href="https://glbforge.dev">glbforge.dev</a></sub>`);
console.log(lines.join('\n'));
