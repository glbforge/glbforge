#!/usr/bin/env node
/**
 * The information surface, checked against the code that produces it.
 *
 * GLBForge is read before it is run — by a person on glbforge.dev and by an
 * agent on /llms.txt — so a stale claim is a product defect, not a typo. Every
 * one of these had actually shipped and nothing caught it:
 *
 *   - `site/index.html` advertised a "27-tool MCP server" in three places
 *     while the server exposed 28.
 *   - `site/budgets/index.html` documented `@2` as the current profile version
 *     after `profiles.ts` published `@3`, with no v3 changelog entry, because
 *     the page is a hand-port of `docs/BUDGETS.md`.
 *   - `docs/BUDGETS.md`'s `@3` tables carried `@2`'s rationale text, so
 *     `list_profiles rationale=true` and the published rationale disagreed
 *     about why a cap is what it is.
 *   - `animate` and `companion` shipped as CLI verbs and appeared in no
 *     command list an agent reads.
 *
 * Two mechanisms, because the two kinds of drift are different:
 *
 *   GENERATE  Anything derivable from the code is generated, so it cannot
 *             drift: the profile tables in `docs/BUDGETS.md` come from
 *             `PROFILE_VERSIONS`, and `site/budgets/index.html` comes from
 *             `docs/BUDGETS.md`. `--fix` writes them; `--check` fails if what
 *             is committed is not what they would be.
 *   CHECK     Prose a person has to write is not generated, but the facts
 *             inside it are counted: tool counts, tool names, CLI verbs,
 *             package versions, profile and pack versions. `--fix` rewrites
 *             only the unambiguous substitutions (a stale count) and reports
 *             the rest.
 *
 * What it does NOT do, so nobody reads more into a green run: it cannot know
 * whether a new capability is DESCRIBED well, or at all, beyond checking that
 * its verb and tool name appear somewhere. That judgment is the scheduled
 * info pass's job (`.claude/skills/glbforge-info-pass/`). Advisory findings
 * are printed but do not fail the gate unless `--strict`.
 *
 * Usage:
 *   node scripts/docs-sync.mjs              # report
 *   node scripts/docs-sync.mjs --check      # exit 1 on gating drift (CI)
 *   node scripts/docs-sync.mjs --fix        # regenerate + substitute, then report
 *   node scripts/docs-sync.mjs --json       # machine output
 *   node scripts/docs-sync.mjs --strict     # advisory findings gate too
 *
 * Exit 0 in step, 1 drift, 2 the check itself could not run.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from './markdown.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const FIX = has('fix');

const at = (...p) => join(root, ...p);
const read = (rel) => readFile(at(rel), 'utf8');

/** A finding. `gate` fails --check; advisory ones need --strict. */
const findings = [];
const gate = (where, message) => findings.push({ where, message, gate: true });
const advise = (where, message) => findings.push({ where, message, gate: false });
const written = [];

// ---------------------------------------------------------------- the code

/**
 * The source of truth for anything versioned. Imported from `dist`, so a
 * check that runs before `pnpm -r build` is an ERROR, never a silent skip —
 * the USD oracle taught this repo what a quietly skipped check is worth.
 */
async function loadCore() {
  const dist = at('packages', 'core', 'dist', 'index.js');
  if (!existsSync(dist)) {
    console.error('packages/core/dist is missing — run `pnpm -r build` first.\n'
      + 'This check reads the published profile and pack registries from the build, and will not\n'
      + 'guess at them from source: a skipped check reads exactly like a passing one.');
    process.exit(2);
  }
  return import(dist);
}

const CAP_ORDER = ['maxTriangles', 'maxDrawCalls', 'maxTextureSize', 'maxTextureBytes', 'maxTextureVramBytes', 'maxFileBytes', 'maxMaterials', 'minSsim'];
const MB = 1024 * 1024;

/** The way each cap is written in the published table. */
function capValue(key, n) {
  if (key.endsWith('Bytes')) return `${+(n / MB).toFixed(2)} MB`;
  if (key === 'maxTextureSize') return `${n} px`;
  if (key === 'minSsim') return String(n);
  return n.toLocaleString('en-US');
}

/** `## Profiles (current versions)` — generated from the registry, in Markdown. */
function profilesSection(PROFILE_VERSIONS) {
  const out = ['## Profiles (current versions)', ''];
  for (const versions of Object.values(PROFILE_VERSIONS)) {
    const p = versions[versions.length - 1];
    const unknown = Object.keys(p.rationale).filter((k) => !CAP_ORDER.includes(k));
    if (unknown.length) throw new Error(`profile ${p.name}@${p.version} has caps this generator has no column order for: ${unknown.join(', ')} — add them to CAP_ORDER in scripts/docs-sync.mjs`);
    const blurb = p.description.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase());
    out.push(`### ${p.name}@${p.version} — ${blurb}`, '');
    out.push('| cap | value | why |', '|---|---|---|');
    for (const key of CAP_ORDER) {
      if (!(key in p.rationale)) continue;
      out.push(`| ${key} | ${capValue(key, p[key])} | ${p.rationale[key].replace(/\|/g, '\\|')} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

/** Replace the region from a `## ` heading up to the next one. */
function replaceSection(markdown, heading, replacement) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) throw new Error(`docs/BUDGETS.md has no "${heading}" heading — this generator writes that section and will not invent a home for it`);
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  const before = lines.slice(0, start).join('\n').replace(/\n+$/, '');
  const after = lines.slice(end).join('\n');
  return `${before}\n\n${replacement}\n${after}`;
}

// ------------------------------------------------------------- generated

async function generated(core) {
  // 1. The profile tables in docs/BUDGETS.md come from the registry.
  const budgetsPath = 'docs/BUDGETS.md';
  const current = await read(budgetsPath);
  // The page below is rendered from what the Markdown SHOULD be, so a single
  // run reports both files rather than hiding the second behind the first.
  const wanted = replaceSection(current, '## Profiles (current versions)', profilesSection(core.PROFILE_VERSIONS));
  if (wanted !== current) {
    if (FIX) { await writeFile(at(budgetsPath), wanted, 'utf8'); written.push(budgetsPath); }
    else gate(budgetsPath, 'the "Profiles (current versions)" tables are not what PROFILE_VERSIONS says — run `pnpm docs:sync`');
  }

  // 2. The web page comes from the Markdown.
  const pagePath = 'site/budgets/index.html';
  const template = await read('scripts/templates/budgets.html');
  if (!template.includes('<!--CONTENT-->')) {
    console.error('scripts/templates/budgets.html lost its <!--CONTENT--> marker');
    process.exit(2);
  }
  const page = template.replace('  <!--CONTENT-->', `  ${render(wanted, { dropTitle: false })}`);
  const committed = await read(pagePath);
  if (page !== committed) {
    if (FIX) { await writeFile(at(pagePath), page, 'utf8'); written.push(pagePath); }
    else gate(pagePath, 'the published budgets page is not what docs/BUDGETS.md renders to — run `pnpm docs:sync`');
  }
  return { budgets: wanted };
}

// ---------------------------------------------------------------- facts

/** Files whose prose states facts about the code. */
const SURFACES = ['site/index.html', 'site/llms.txt', 'README.md', 'packages/mcp/README.md'];

/**
 * Top-level CLI verbs that are deliberately absent from the public command
 * lists, with the reason. Anything else that exists must be documented.
 */
const UNLISTED_VERBS = {
  watch: 'a convenience wrapper around analyze; nothing to promise an agent',
  align: 'internal harness for the fixture calibration, not a product surface',
  dataset: 'internal: builds the training-set manifests under training/',
};

async function facts(core) {
  const pkgPaths = ['packages/cli', 'packages/core', 'packages/mcp', 'packages/meshy', 'packages/studio', 'companion'];
  const pkgs = await Promise.all(pkgPaths.map(async (p) => ({ path: p, ...JSON.parse(await read(`${p}/package.json`)) })));
  const versions = [...new Set(pkgs.map((p) => p.version))];
  if (versions.length > 1) {
    gate('package versions', `the six packages are not on one version: ${pkgs.map((p) => `${p.name} ${p.version}`).join(', ')} — a release tags them together`);
  }
  const version = pkgs[0].version;

  const server = JSON.parse(await read('server.json'));
  const serverVersions = new Set([server.version, ...(server.packages ?? []).map((p) => p.version)].filter(Boolean));
  for (const v of serverVersions) {
    if (v !== version) gate('server.json', `declares ${v}, the packages are at ${version} — the MCP registry entry would publish the wrong version`);
  }

  const changelog = await read('CHANGELOG.md');
  if (!new RegExp(`^##\\s+(\\[?${version.replace(/\./g, '\\.')}\\]?|Unreleased)`, 'm').test(changelog)) {
    gate('CHANGELOG.md', `has no "## ${version}" section and no "## Unreleased" — a version was bumped without a changelog entry`);
  }

  // --- the MCP tool surface. schemas/index.json is generated by the mcp
  // build from the running server, and the probe checks it against stdio; it
  // is the committed truth about how many tools there are.
  const index = JSON.parse(await read('schemas/index.json'));
  const tools = Object.keys(index.tools);

  const llms = await read('site/llms.txt');
  const missingFromLlms = tools.filter((t) => !llms.includes(t));
  if (missingFromLlms.length) gate('site/llms.txt', `does not name ${missingFromLlms.length} of the ${tools.length} MCP tools: ${missingFromLlms.join(', ')} — that list is how an agent learns what exists`);

  for (const rel of SURFACES) {
    const text = await read(rel);
    const counts = [...text.matchAll(/(\d+)([- ]tools?\b)/g)].filter((m) => /tool/.test(m[2]));
    const wrong = counts.filter((m) => Number(m[1]) !== tools.length);
    if (!wrong.length) continue;
    if (FIX) {
      let fixed = text;
      for (const m of wrong) fixed = fixed.split(`${m[1]}${m[2]}`).join(`${tools.length}${m[2]}`);
      if (fixed !== text) { await writeFile(at(rel), fixed, 'utf8'); written.push(rel); }
    } else {
      const where = [...new Set(wrong.map((m) => `"${m[0]}"`))].join(', ');
      gate(rel, `claims ${where}; the server exposes ${tools.length} — run \`pnpm docs:sync\``);
    }
  }

  // --- CLI verbs. A verb that exists and is named nowhere an agent reads is
  // a shipped feature nobody can find.
  const cliSources = ['packages/cli/src/index.ts', 'packages/cli/src/companion-cmd.ts', 'packages/cli/src/init.ts', 'packages/cli/src/meshy-cmd.ts'];
  const verbs = new Set();
  for (const src of cliSources) {
    const text = await read(src);
    // Top-level verbs only: meshy's own subcommands hang off `meshy`.
    const top = src.endsWith('meshy-cmd.ts') ? ['meshy'] : [...text.matchAll(/^\s*(?:program|\w+)?\s*\.command\('([a-z-]+)'/gm)].map((m) => m[1]);
    for (const v of top) verbs.add(v);
  }
  // The "## Commands" section specifically, not the prose: that list is what
  // an agent copies a command out of. `animate` and `companion` were described
  // in the prose above it for four days and absent from it.
  const commands = /^## Commands$([\s\S]*?)(?=^## |\Z)/m.exec(llms)?.[1] ?? '';
  if (!commands.trim()) gate('site/llms.txt', 'has no "## Commands" section — that is the list an agent copies from');
  const undocumented = [...verbs].filter((v) => !(v in UNLISTED_VERBS) && !new RegExp(`glbforge ${v}\\b`).test(commands));
  if (undocumented.length) {
    gate('site/llms.txt', `the "## Commands" list has no entry for CLI verb${undocumented.length > 1 ? 's' : ''} ${undocumented.join(', ')} — shipped and uncopyable`);
  }
  const ghosts = Object.keys(UNLISTED_VERBS).filter((v) => !verbs.has(v));
  if (ghosts.length) advise('scripts/docs-sync.mjs', `UNLISTED_VERBS still excuses ${ghosts.join(', ')}, which the CLI no longer has`);

  // --- versioned contracts: a reference to a version that does not exist is
  // always wrong, in either direction.
  const registries = {
    profile: Object.fromEntries(Object.entries(core.PROFILE_VERSIONS).map(([n, v]) => [n, v.map((p) => p.version)])),
    pack: Object.fromEntries(Object.entries(core.PACK_VERSIONS).map(([n, v]) => [n, v.map((p) => p.version)])),
    'rule profile': Object.fromEntries(Object.entries(core.RULE_PROFILE_VERSIONS).map(([n, v]) => [n, v.map((p) => p.version)])),
  };
  const docSurfaces = [...SURFACES, 'docs/BUDGETS.md', 'CLAUDE.md', 'ROADMAP.md'];
  const allNames = Object.entries(registries).flatMap(([kind, reg]) => Object.entries(reg).map(([name, published]) => ({ kind, name, published })));
  for (const rel of docSurfaces) {
    const text = await read(rel);
    for (const { kind, name, published } of allNames) {
      for (const m of text.matchAll(new RegExp(`\\b${name.replace(/[/-]/g, '\\$&')}@(\\d+)`, 'g'))) {
        const v = Number(m[1]);
        if (!published.includes(v)) gate(rel, `names ${kind} ${name}@${v}, which was never published (published: ${published.join(', ')})`);
      }
    }
    // "`@3` is current" style claims. Attributed to the nearest registry name
    // mentioned before the phrase — anything looser reports one stale claim
    // once per registered name, which is noise rather than a finding.
    for (const m of text.matchAll(/`?@(\d+)`?\s+is\s+current/g)) {
      const lookback = text.slice(Math.max(0, m.index - 300), m.index);
      const subject = allNames
        .map((entry) => ({ entry, where: lookback.lastIndexOf(entry.name) }))
        .filter(({ where }) => where >= 0)
        .sort((a, b) => b.where - a.where)[0]?.entry;
      if (!subject) continue;
      const latest = subject.published[subject.published.length - 1];
      if (Number(m[1]) !== latest) advise(rel, `says "@${m[1]} is current" about ${subject.kind} ${subject.name}, whose latest published version is @${latest}`);
    }
  }

  // --- the version line agents read as "what is shipped".
  const line = /in step with the repository's main branch\s*—?\s*the\s+([0-9]+\.[0-9]+\.[0-9]+)\s+line/.exec(llms.replace(/\s+/g, ' '));
  if (!line) {
    advise('site/llms.txt', 'has no "the X.Y.Z line" version statement to check');
  } else if (line[1] !== version) {
    // Naming the version main is ABOUT to be is the tempting mid-cycle
    // wording and it is wrong in the way that matters: an agent is told about
    // a release that does not exist, and `npm i glbforge@0.9.0` fails. The
    // file names what main is; the CHANGELOG's Unreleased section is where
    // "merged but not published" belongs. The agent probe says the same.
    gate('site/llms.txt', `says it is in step with the ${line[1]} line; the packages are at ${version} — an agent reading it is told about a release that does not exist`);
  }

  return { version, tools: tools.length, verbs: [...verbs].sort() };
}

// ---------------------------------------------------------------- run

const core = await loadCore();
let summary;
try {
  await generated(core);
  summary = await facts(core);
} catch (e) {
  console.error(`docs-sync could not complete: ${e?.message ?? e}`);
  process.exit(2);
}

const gating = findings.filter((f) => f.gate);
const advisory = findings.filter((f) => !f.gate);

if (has('json')) {
  console.log(JSON.stringify({ ok: gating.length === 0, summary, written, findings }, null, 2));
} else {
  const label = `${summary.tools} MCP tools · ${summary.verbs.length} CLI verbs · packages ${summary.version}`;
  if (written.length) console.log(`rewrote ${written.length} file(s):\n${written.map((w) => `  ${w}`).join('\n')}`);
  if (!findings.length) console.log(`docs in step with the code  ·  ${label}`);
  else {
    if (gating.length) console.log(`drift (${gating.length}):\n${gating.map((f) => `  ${f.where}: ${f.message}`).join('\n')}`);
    if (advisory.length) console.log(`advisory (${advisory.length}):\n${advisory.map((f) => `  ${f.where}: ${f.message}`).join('\n')}`);
    console.log(`  ·  ${label}`);
  }
}

const fails = has('strict') ? findings.length : gating.length;
process.exit((has('check') || has('gate')) && fails ? 1 : 0);
