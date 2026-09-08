#!/usr/bin/env node
/**
 * Renders the GLBForge PR comment / optimization-PR body from a directory of
 * `glbforge analyze --json` results (one `<file>.json` per asset) plus, in
 * optimize mode, `<file>.after.json` (the `glbforge optimize --json` output).
 *
 * Usage: report.mjs <dir> <profileName> [--count-failing]
 *   --count-failing prints only the number of assets that fail the gate:
 *   the original is over budget AND there is no passing optimized output.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const countOnly = args.includes('--count-failing');
const [dir, profile = 'mobile-hero'] = args.filter((a) => !a.startsWith('--'));

const mb = (bytes) => (bytes / 1048576).toFixed(1) + 'MB';
const num = (value) => value.toLocaleString('en-US');
const pct = (n) => (n * 100).toFixed(1) + '%';

const results = readdirSync(dir)
  .filter((file) => file.endsWith('.json') && !file.endsWith('.after.json'))
  .map((file) => {
    const before = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const afterPath = join(dir, file.replace(/\.json$/, '.after.json'));
    const after = existsSync(afterPath) ? JSON.parse(readFileSync(afterPath, 'utf8')) : null;
    return { before, after };
  })
  .sort((a, b) => (a.before.file?.path ?? '').localeCompare(b.before.file?.path ?? ''));

const failsGate = ({ before, after }) => {
  if (before.lfsPointer || before.error) return false; // reported, not gated
  if (before.passed) return false;
  return !(after && after.after?.passed);
};

if (countOnly) {
  console.log(results.filter(failsGate).length);
  process.exit(0);
}

const optimized = results.filter((r) => r.after);
const lines = [];
const version = results.find((r) => r.before.profile?.version)?.before.profile.version;
lines.push(`## 📦 GLBForge report — \`${profile}${version ? '@' + version : ''}\` budget`);
lines.push('');
lines.push('| Asset | Score | Verdict | Triangles | Draw calls | File | GPU mem | Visual SSIM |');
lines.push('|---|---|---|---|---|---|---|---|');

const fidelityCell = (after) => {
  const p = after?.perceptual;
  if (!p) return after ? '—' : '';
  return `${p.passed ? '✅' : '🔴'} ${pct(p.ssimMin)}`;
};

for (const { before: r, after } of results) {
  const path = r.file?.path ?? '(unknown)';
  if (r.lfsPointer) {
    lines.push(`| \`${path}\` | — | ⚠️ LFS pointer | — | — | — | — | |`);
    continue;
  }
  if (r.error) {
    lines.push(`| \`${path}\` | — | ❌ failed to analyze | — | — | — | — | |`);
    continue;
  }
  const verdict = r.passed ? '✅ within budget' : '🔴 over budget';
  lines.push(
    `| \`${path}\` | **${r.score}**/100 | ${verdict} | ${num(r.geometry.triangles)} | ~${r.geometry.drawCallEstimate} | ${mb(r.file.bytes)} | ${mb(r.textureVramTotal)} | |`,
  );
  if (after) {
    const a = after.after;
    const v = a.passed ? '✅ within budget' : '🔴 over budget';
    const saved = typeof after.savedPct === 'number' ? ` (−${after.savedPct}%)` : '';
    lines.push(
      `| ↳ \`${after.outPath}\` | **${a.score}**/100 | ${v} | ${num(a.geometry.triangles)} | ~${a.geometry.drawCallEstimate} | ${mb(a.file.bytes)}${saved} | ${mb(a.textureVramTotal)} | ${fidelityCell(after)} |`,
    );
    for (const lod of after.lods ?? []) {
      const short = lod.triangles > lod.target * 1.1 ? ` (target ${num(lod.target)} not reachable)` : '';
      lines.push(`| ↳ \`${lod.path}\` | — | LOD, geometry only${short} | ${num(lod.triangles)} | — | ${mb(lod.bytes)} | — | |`);
    }
  }
}

if (optimized.length) {
  const total = optimized.reduce((s, r) => s + (r.before.file?.bytes ?? 0), 0);
  const totalAfter = optimized.reduce((s, r) => s + (r.after.after.file.bytes ?? 0), 0);
  const worst = optimized.map((r) => r.after.perceptual?.ssimMin).filter((n) => typeof n === 'number');
  lines.push('');
  lines.push(
    `**Optimized ${optimized.length} asset(s): ${mb(total)} → ${mb(totalAfter)}` +
    (total ? ` (${pct(1 - totalAfter / Math.max(1, total))} smaller)` : '') +
    (worst.length ? `; lowest visual-fidelity SSIM ${pct(Math.min(...worst))}` : '') +
    `.** Visual SSIM compares four fixed-camera renders before vs after; the weakest view must clear the profile floor.`,
  );
}

for (const { before: r, after } of results) {
  const path = r.file?.path ?? '(unknown)';
  if (r.lfsPointer) {
    lines.push('', `> ⚠️ \`${path}\` is a git-LFS pointer — add \`lfs: true\` to \`actions/checkout\` so GLBForge can read the real file.`);
    continue;
  }
  if (r.error) {
    lines.push('', `> ❌ \`${path}\`: ${String(r.error).slice(0, 300)}`);
    continue;
  }
  const sections = [[path, r.findings ?? []]];
  if (after) sections.push([after.outPath, after.after.findings ?? []]);
  for (const [name, findings] of sections) {
    if (!findings.length) continue;
    lines.push('');
    lines.push(`<details><summary><b>${name}</b> — ${findings.length} finding(s)</summary>`);
    lines.push('');
    for (const f of findings) {
      const icon = { error: '🔴', warn: '🟡', info: 'ℹ️' }[f.severity] ?? '•';
      lines.push(`- ${icon} **\`${f.ruleId}\`** — ${f.message}`);
      if (f.suggestion) lines.push(`  - ↳ ${f.suggestion}`);
    }
    lines.push('');
    lines.push('</details>');
  }
  if (after?.steps?.length) {
    lines.push('', `<sub>${after.outPath}: ${after.steps.join(' → ')}</sub>`);
  }
}

lines.push('');
lines.push(`<sub>Fix locally: \`npx glbforge optimize <file> --profile ${profile}\` · <a href="https://glbforge.dev">glbforge.dev</a></sub>`);
console.log(lines.join('\n'));
