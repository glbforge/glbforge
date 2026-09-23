#!/usr/bin/env node
/**
 * Fold the pass files into docs/agent-loop/ledger.md.
 *
 * The ledger used to be one hand-edited file that every pass prepended to,
 * which made it the one place concurrent passes were guaranteed to collide:
 * three open PRs, three new sections at line 13, three conflicts. A finding
 * is also not a diary entry — its state changes over time, and a reader
 * wants "what is open right now", which a reverse-chronological log makes
 * you reconstruct by reading the whole thing.
 *
 * So passes/ is append-only — one new file per pass, and a new file never
 * conflicts — and this regenerates the index from it. Later passes override
 * earlier ones for the same finding id, so closing L2 is just writing
 * `### L2 · `fixed` · …` in your own file.
 *
 * A pass writes a heading ONLY for a finding it raises or whose state it
 * changes. Restating one it merely looked at would make it the newest
 * mention and silently reopen something a concurrent pass had closed — the
 * index is what carries findings forward, which is the point of generating
 * it. A pass that changed nothing has no headings at all, and that is a
 * valid, recorded outcome.
 *
 * The format is what the loop already wrote, so there is nothing extra to
 * remember:
 *
 *   # Pass — YYYY-MM-DD — <commit or run id>
 *   ### L<n> · `state` · <title>
 *
 * states: open | fixed | wontfix | watching
 *
 *   node scripts/ledger.mjs            # regenerate
 *   node scripts/ledger.mjs --check    # exit 1 if stale (CI)
 *
 * On a merge conflict in ledger.md, do not resolve it by hand: take either
 * side and re-run this.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'docs', 'agent-loop', 'passes');
const out = join(root, 'docs', 'agent-loop', 'ledger.md');

const STATES = new Set(['open', 'fixed', 'wontfix', 'watching']);
const HEAD = /^#\s+Pass\s+—\s+(\d{4}-\d{2}-\d{2})\s+—\s+(.+?)\s*$/m;
const ROLE = /^\*\*Role:\*\*\s+([a-z][a-z-]*)\s*$/m;
/** Kept in step with docs/agent-loop/ROLES.md; a pass takes the least recent. */
const ROLES = ['auditor', 'newcomer', 'saboteur', 'rival', 'integrator', 'performance', 'archaeologist', 'newcomer-to-new-code'];
const FINDING = /^###\s+(L\d+)\s+·\s+`([a-z]+)`\s+·\s+(.+?)\s*$/gm;

const problems = [];

const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
const passes = [];
for (const file of files) {
  const text = await readFile(join(dir, file), 'utf8');
  const head = text.match(HEAD);
  if (!head) { problems.push(`${file}: no "# Pass — YYYY-MM-DD — <ref>" heading`); continue; }
  const findings = [];
  for (const m of text.matchAll(FINDING)) {
    const [, id, state, title] = m;
    if (!STATES.has(state)) problems.push(`${file}: ${id} has state \`${state}\`; expected one of ${[...STATES].join(', ')}`);
    findings.push({ id, state, title });
  }
  const seen = new Set();
  for (const f of findings) {
    if (seen.has(f.id)) problems.push(`${file}: ${f.id} appears twice — one heading per finding per pass`);
    seen.add(f.id);
  }

  const role = text.match(ROLE)?.[1] ?? null;
  if (role && !ROLES.includes(role)) problems.push(`${file}: unknown role \`${role}\`; see docs/agent-loop/ROLES.md`);
  passes.push({ file, date: head[1], ref: head[2], role, findings });
}

// Sort by date, then filename, so two passes on one day stay deterministic.
passes.sort((a, b) => (a.date === b.date ? a.file.localeCompare(b.file) : a.date.localeCompare(b.date)));

if (problems.length) {
  console.error('Pass files are malformed:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(2);
}

// Fold: the last pass to mention a finding owns its state.
const current = new Map();
for (const p of passes) {
  for (const f of p.findings) {
    const first = current.get(f.id)?.first ?? p;
    current.set(f.id, { ...f, first, last: p });
  }
}
const byId = [...current.values()].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
const openish = byId.filter((f) => f.state === 'open' || f.state === 'watching');
const closed = byId.filter((f) => f.state === 'fixed' || f.state === 'wontfix');

const link = (p) => `passes/${p.file}`;

// Least-recently-used ordering: never-used roles first, then oldest last-use.
const rotation = ROLES
  .map((role) => {
    const used = passes.filter((p) => p.role === role);
    return { role, count: used.length, last: used[used.length - 1] ?? null };
  })
  .sort((a, b) => {
    if (!a.last && !b.last) return ROLES.indexOf(a.role) - ROLES.indexOf(b.role);
    if (!a.last) return -1;
    if (!b.last) return 1;
    return a.last.date === b.last.date ? a.last.file.localeCompare(b.last.file) : a.last.date.localeCompare(b.last.date);
  });
const row = (f) => `| \`${f.id}\` | ${f.state} | ${f.title} | [${f.first.date}](${link(f.first)}) | [${f.last.date}](${link(f.last)}) |`;

const L = [];
L.push('<!-- Generated by scripts/ledger.mjs from docs/agent-loop/passes/. Do not edit:');
L.push('     write your finding in your own pass file and run `pnpm ledger`. -->');
L.push('');
L.push('# Agent-loop ledger');
L.push('');
L.push('Every finding the loop has made, and where it stands **now**. A pass reads');
L.push('this first, so that pass 40 does not spend its budget rediscovering what');
L.push('pass 3 wrote down, and does not re-file something closed as working as');
L.push('intended.');
L.push('');
L.push('One file per pass in [`passes/`](passes/), append-only. A later pass changes');
L.push('a finding\'s state by writing its own heading for that id — the newest');
L.push('mention wins, and this index is regenerated from all of them.');
L.push('');
L.push(`**${openish.length} open** · ${closed.length} closed · ${passes.length} passes`);
L.push('');
L.push('## Open');
L.push('');
if (openish.length) {
  L.push('| id | state | finding | first seen | last touched |');
  L.push('|---|---|---|---|---|');
  for (const f of openish) L.push(row(f));
} else {
  L.push('Nothing open.');
}
L.push('');
L.push('## Closed');
L.push('');
L.push('| id | state | finding | first seen | last touched |');
L.push('|---|---|---|---|---|');
for (const f of closed) L.push(row(f));
L.push('');
L.push('## Roles');
L.push('');
L.push('Least recently used first. A pass takes the top one — see');
L.push('[ROLES.md](ROLES.md), which says what each stance counts as success.');
L.push('');
L.push('| role | passes | last used |');
L.push('|---|---|---|');
for (const r of rotation) L.push(`| ${r.role} | ${r.count} | ${r.last ? `[${r.last.date}](${link(r.last)})` : '**never**'} |`);
L.push('');
L.push('## Passes');
L.push('');
for (const p of [...passes].reverse()) {
  const what = p.findings.length ? p.findings.map((f) => `\`${f.id}\` ${f.state}`).join(', ') : 'nothing to fix';
  L.push(`- **${p.date}** — [${p.file.replace(/\.md$/, '')}](${link(p)})${p.role ? ` — *${p.role}*` : ''} — \`${p.ref}\` — ${what}`);
}
L.push('');

const text = L.join('\n');
if (process.argv.includes('--check')) {
  const existing = await readFile(out, 'utf8').catch(() => '');
  if (existing !== text) {
    console.error('docs/agent-loop/ledger.md is stale — run `pnpm ledger` and commit the result.');
    process.exit(1);
  }
  console.log(`ledger.md is in sync (${byId.length} findings across ${passes.length} passes).`);
} else {
  await writeFile(out, text);
  console.log(`ledger.md: ${openish.length} open, ${closed.length} closed, ${passes.length} passes.`);
  console.log(`next role (least recently used): ${rotation[0].role}`);
}
