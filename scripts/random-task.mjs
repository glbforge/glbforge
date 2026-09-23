#!/usr/bin/env node
/**
 * Draw a random end-to-end task for an agent that uses GLBForge, with the
 * feedback template a pass files against it. Seeded, so a pass can cite the
 * draw it walked (`pnpm random-task -- --seed 42`) and another pass can redraw
 * the same one. The point is the walk, not the task: every place the agent
 * has to guess, open a file, or already know something is a defect.
 *
 *   pnpm random-task                    # a fresh draw (seed = today's date)
 *   pnpm random-task -- --seed 7        # a specific draw
 *   pnpm random-task -- --seed 7 --json # machine-readable
 */
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const seedArg = flag('--seed');
const seed = seedArg !== undefined ? Number(seedArg) : Number(new Date().toISOString().slice(0, 10).replace(/-/g, ''));

// mulberry32: small, seedable, good enough to spread a matrix.
function rng(s) { return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(seed);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

const examplesDir = join(root, 'examples');
const examples = existsSync(examplesDir) ? readdirSync(examplesDir).filter((f) => f.endsWith('.glb') && !/\.(web|ktx2|lod\d)\.glb$/.test(f)).sort() : [];

const SOURCES = [
  ...examples.map((f) => ({ kind: 'glb', what: `examples/${f}`, note: 'a checked-out example (regenerate with the CLI if missing)' })),
  { kind: 'image', what: 'a transparent-background PNG logo of your choosing', note: 'the forge path; the matte decides the silhouette' },
  { kind: 'image', what: 'a photo of an object on a plain background (JPEG, no alpha)', note: 'subject lifting must carry it or refuse with numbers' },
  { kind: 'image', what: 'an SVG icon', note: 'vector input is traced, not rasterized' },
  { kind: 'glb', what: 'a raw Meshy / Hunyuan download you already have (2M+ triangles)', note: 'no paid generation: use one on disk' },
];
const GOALS = [
  { id: 'web-hero', text: 'ship it as a mobile-hero web asset that passes the budget with no visible loss', tools: ['analyze_glb', 'optimize_glb', 'inspect', 'diff'] },
  { id: 'ar', text: 'get it into AR Quick Look on an iPhone, textures intact', tools: ['optimize_glb', 'export_usdz', 'validate'] },
  { id: 'print', text: 'make a printable STL, ~80 mm, and say whether a slicer will need to repair it', tools: ['inspect', 'export_stl'] },
  { id: 'companion', text: 'give it a looping idle motion and a reaction clip, then put it on the desktop as a companion an agent can talk through', tools: ['animate', 'render_animation_strip', 'companion_load', 'companion_say', 'companion_snapshot'] },
  { id: 'review', text: 'review two versions of it as a change note: what got better, what regressed, with pictures', tools: ['diff', 'render', 'compare_glb'] },
  { id: 'configurator', text: 'prepare it for a product configurator: desktop budget, materials named and inspectable, LODs', tools: ['optimize_glb', 'inspect_materials', 'analyze_performance'] },
];
const CONSTRAINTS = [
  'you may only use what the tools return — never open a file in another program',
  'the final asset must be watertight, or the report must say exactly why it cannot be',
  'the origin must end at the base centre',
  'declare an expectation up front (category, size, up axis) and hold the output to it',
  'do it twice from the same input and prove the bytes match',
  'stay under 60 seconds of tool time end to end',
  'every number you report must come from a tool, with the tool named',
];
const TWISTS = [
  'the input has KTX2 textures',
  'the input is the .web.glb, already optimized once',
  'the input is a USDZ, not a GLB',
  'the profile is pinned to a version that is not the latest',
  'the image has an antialiased edge and a drop shadow',
  'the asset has 10 identical parts placed by 10 nodes',
  'the asset already carries a skeleton and one clip',
  'no twist — the plain path',
];

const source = pick(SOURCES), goal = pick(GOALS), constraint = pick(CONSTRAINTS), twist = pick(TWISTS);
const task = { seed, source, goal, constraint, twist };

if (args.includes('--json')) { console.log(JSON.stringify(task, null, 2)); process.exit(0); }

console.log(`# Random agent task · seed ${seed}

**Start from:** ${source.what}  _(${source.note})_
**Goal:** ${goal.text}.
**Constraint:** ${constraint}.
**Twist:** ${twist}.
**Tools you will probably reach for:** ${goal.tools.map((t) => `\`${t}\``).join(', ')} — but use what the descriptions tell you, not this list.

Play it as an agent with no other context: read the tool descriptions, follow
\`nextActions\`, and stop when the goal is met or a tool cannot take you further.

## Feedback to file (docs/agent-tasks/<date>-<slug>.md)

For each step, in order:
| # | tool + args | what it said | what you did next | verdict |
|---|---|---|---|---|

Verdicts: \`clear\` (the reply told you what to do next and it worked),
\`guessed\` (you chose an argument or a next tool without the reply telling you),
\`opened-a-file\` (you had to look outside the tool surface), \`knew\` (it only
worked because you already knew something about GLBForge), \`wrong\` (the
advice did not resolve what it claimed), \`slow\` (over 2 s for an inner-loop
call, over 30 s for anything).

Then, the findings — one heading per defect, in the ledger's shape
(\`Fn · state · one line\`), each with the evidence (the reply text or number)
and the change that would have made the step \`clear\`. A task with no
findings is a finding: say which steps were clear and why.
`);
