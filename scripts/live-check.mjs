#!/usr/bin/env node
/**
 * glbforge.dev, from outside.
 *
 * The scheduled agent pass cannot do this: its sandbox allowlists npmjs.org
 * and fails CONNECT on everything else, so a live check there reports a false
 * outage rather than a real one (ledger L7). This runs on a machine that can
 * actually reach the site.
 *
 * Deliberately plain Node — no build, no pnpm, no workspace resolution — so a
 * launchd job can run it against a checkout that is mid-rebuild, or broken,
 * and still tell you whether the site is up.
 *
 * What it checks, and why each one has failed before:
 *
 *   pages      Static routes return 200. The floor.
 *   worker     The two free, unauthenticated API routes. The static site is
 *              served by the same Worker that serves /api/*, so the assets
 *              can be fine while the Worker is throwing — and the Studio's
 *              first call is the thing that breaks.
 *   assets     Every script/style the DEPLOYED Studio page references is
 *              fetched. Hashed bundles have raced the build into a deploy
 *              whose index.html pointed at files that were not there, which
 *              is invisible to a 200 on the page itself.
 *   drift      Deployed llms.txt vs origin/main — not the working tree, or
 *              every open PR would hold it red. Agents read that file; if it
 *              is not what was merged, the scope statement they act on is
 *              not the one that shipped.
 *   versions   npm `latest` vs the packages in this checkout.
 *
 * Usage:
 *   node scripts/live-check.mjs                  # check, print, append history
 *   node scripts/live-check.mjs --notify         # + macOS notification ON CHANGE
 *   node scripts/live-check.mjs --json           # machine output
 *   node scripts/live-check.mjs --quiet          # print only when something is wrong
 *
 * Exit 0 all good, 1 something is wrong, 2 the check itself broke.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = process.env.GLBFORGE_ORIGIN ?? 'https://glbforge.dev';
const HISTORY = join(root, '.agent-loop', 'live-history.jsonl');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const TIMEOUT = 20_000;

const problems = [];
const note = (s) => problems.push(s);

async function get(url, as = 'text') {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), redirect: 'follow' });
    const body = as === 'none' ? '' : await r.text();
    return { url, status: r.status, ms: Date.now() - t0, body, ok: r.ok };
  } catch (e) {
    return { url, status: 0, ms: Date.now() - t0, body: '', ok: false, error: String(e?.message ?? e).slice(0, 160) };
  }
}

// ---------------------------------------------------------------- checks

const PAGES = ['/', '/llms.txt', '/budgets/', '/studio/', '/privacy/', '/terms/'];
// Unauthenticated, free, no side effects. Everything under /api/gen/ and
// /api/billing/checkout costs money or mutates and is never touched here.
const WORKER = ['/api/auth/providers', '/api/billing/packs'];

async function checkPages() {
  const rows = await Promise.all(PAGES.map((p) => get(ORIGIN + p)));
  for (const r of rows) if (!r.ok) note(`${r.url} → ${r.error ?? r.status}`);
  return rows.map(({ url, status, ms, error }) => ({ url, status, ms, ...(error ? { error } : {}) }));
}

async function checkWorker() {
  const rows = await Promise.all(WORKER.map((p) => get(ORIGIN + p)));
  for (const r of rows) {
    if (!r.ok) { note(`${r.url} → ${r.error ?? r.status} (the Worker serves the site too)`); continue; }
    try { JSON.parse(r.body); } catch { note(`${r.url} returned ${r.status} but not JSON`); }
  }
  return rows.map(({ url, status, ms, error }) => ({ url, status, ms, ...(error ? { error } : {}) }));
}

/** Every script/style the deployed Studio page points at must resolve. */
async function checkStudioAssets() {
  const page = await get(`${ORIGIN}/studio/`);
  if (!page.ok) return { checked: 0, missing: [], skipped: 'studio page did not load' };
  const refs = [...page.body.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => /\.(js|css)(\?|$)/.test(u))
    .map((u) => (u.startsWith('http') ? u : new URL(u, `${ORIGIN}/studio/`).toString()));
  const unique = [...new Set(refs)];
  const rows = await Promise.all(unique.map((u) => get(u, 'none')));
  const missing = rows.filter((r) => !r.ok).map((r) => `${r.url} → ${r.error ?? r.status}`);
  for (const m of missing) note(`Studio references an asset that does not resolve: ${m}`);
  return { checked: unique.length, missing };
}

/**
 * Compared against origin/main, NOT the working tree.
 *
 * The question worth alerting on is "is the deploy behind what was merged",
 * not "has someone edited a file locally" — a feature branch is ahead of the
 * deploy by definition, and comparing the working tree makes this red for
 * the entire life of every PR, which trains you to ignore it.
 */
function mainCopy(path) {
  try {
    return execFileSync('git', ['show', `origin/main:${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
}

/**
 * The three pages whose content is a claim about the product. `/llms.txt` is
 * what an agent acts on; `/` and `/budgets/` are what a person reads, and the
 * budgets page is generated from docs/BUDGETS.md, so a stale deploy of it
 * means the published rationale is not the one the tool reports.
 */
const DRIFT = [['/llms.txt', 'site/llms.txt'], ['/', 'site/index.html'], ['/budgets/', 'site/budgets/index.html']];

async function checkDrift() {
  const rows = [];
  for (const [route, path] of DRIFT) {
    const deployed = await get(ORIGIN + route);
    if (!deployed.ok) { rows.push({ route, compared: false, reason: `could not fetch (${deployed.error ?? deployed.status})` }); continue; }
    const ref = mainCopy(path);
    if (ref === null) { rows.push({ route, compared: false, reason: 'origin/main not available — run git fetch' }); continue; }
    const same = deployed.body.trim() === ref.trim();
    if (!same) note(`deployed ${route} differs from origin/main:${path} (${deployed.body.trim().length} vs ${ref.trim().length} bytes) — the site is not serving what was merged`);
    rows.push({ route, path, compared: true, against: 'origin/main', same, deployedBytes: deployed.body.trim().length, mainBytes: ref.trim().length });
  }
  const compared = rows.filter((r) => r.compared);
  return { routes: rows, compared: compared.length > 0, same: compared.length > 0 && compared.every((r) => r.same) };
}

async function checkVersions() {
  let repo = null;
  try { repo = JSON.parse(readFileSync(join(root, 'packages', 'core', 'package.json'), 'utf8')).version; } catch { /* not fatal */ }
  const r = await get('https://registry.npmjs.org/glbforge/latest');
  let npm = null;
  if (r.ok) { try { npm = JSON.parse(r.body).version; } catch { /* below */ } }
  if (!r.ok) note(`npm registry unreachable → ${r.error ?? r.status}`);
  else if (npm && repo && npm !== repo) note(`npm latest is ${npm}, this checkout is ${repo}`);
  return { repo, npm };
}

// ------------------------------------------------------------------ main

async function main() {
  const at = new Date().toISOString();
  const report = { at, origin: ORIGIN };
  report.pages = await checkPages();
  report.worker = await checkWorker();
  report.studioAssets = await checkStudioAssets();
  report.drift = await checkDrift();
  report.versions = await checkVersions();
  report.problems = problems;
  report.ok = problems.length === 0;

  // History, so a flap is distinguishable from a standing failure.
  let previous = null;
  try {
    const lines = (await readFile(HISTORY, 'utf8')).trim().split('\n').filter(Boolean);
    // Only compare against the last run for the SAME origin: a staging check
    // or a throwaway run against another host must not read as a state change
    // for production.
    for (let i = lines.length - 1; i >= 0; i--) {
      const row = JSON.parse(lines[i]);
      if (row.origin === ORIGIN) { previous = row; break; }
    }
  } catch { /* first run */ }
  await mkdir(dirname(HISTORY), { recursive: true });
  await appendFile(HISTORY, JSON.stringify(report) + '\n');

  // Only a CHANGE is worth interrupting anyone for. A site that has been
  // down for six hours does not deserve six notifications, and a recovery
  // deserves exactly one.
  const changed = !previous
    || previous.ok !== report.ok
    || JSON.stringify(previous.problems ?? []) !== JSON.stringify(report.problems);

  if (has('json')) {
    console.log(JSON.stringify({ ...report, changed }, null, 2));
  } else if (!has('quiet') || !report.ok || changed) {
    const slowest = [...report.pages, ...report.worker].sort((a, b) => b.ms - a.ms)[0];
    console.log(`${report.ok ? 'OK ' : 'FAIL'}  ${ORIGIN}  ${at}`);
    console.log(`  ${report.pages.length} pages, ${report.worker.length} worker routes, ${report.studioAssets.checked} studio assets`
      + `  ·  slowest ${slowest?.url.replace(ORIGIN, '') ?? '?'} ${slowest?.ms ?? '?'}ms`
      + `  ·  npm ${report.versions.npm ?? '?'} / repo ${report.versions.repo ?? '?'}`
      + `  ·  ${report.drift.routes.filter((r) => r.compared).length}/${report.drift.routes.length} content routes ${report.drift.compared ? (report.drift.same ? 'in step with main' : 'DRIFTED from main') : 'not compared'}`);
    for (const p of report.problems) console.log(`  ✗ ${p}`);
    if (!changed && !report.ok) console.log('  (unchanged since the last run)');
  }

  if (has('notify') && changed) {
    const title = report.ok ? 'glbforge.dev recovered' : 'glbforge.dev';
    const msg = report.ok ? 'All checks passing again.' : report.problems.slice(0, 2).join(' · ').slice(0, 200);
    execFile('osascript', ['-e', `display notification ${JSON.stringify(msg)} with title ${JSON.stringify(title)}`], () => {});
  }

  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => { console.error('live-check itself failed:', e); process.exit(2); });
