# Pass — 2026-09-24 — b59f0d2
**Role:** newcomer

`rival`, `integrator`, `performance` and `archaeologist` are all currently
claimed by open PRs (#28, #29, #30, #31 — `gh pr list` confirms each
`agent-loop/*` branch and its title match its role), so per ROLES.md ("if the
least-recent role genuinely cannot run this pass... take the next one and
write down why") I skipped past all four never-used roles rather than
duplicate work already in flight, and took the next slot in the rotation:
`newcomer`, last used 2026-09-22.

The job: get a real logo into 3D and onto a page, using only what the CLI's
own `--help` and error messages say — no reading source until a defect was
already reproduced. Picked `site/icon-512.png` (GLBForge's own icon, 512x512,
opaque, no alpha) as the artwork.

`glbforge extrude icon.png` refused it outright: "this looks like a
photograph... if it is an object on a plain background, matte lifts it out
for free... preview the cut first with `--matte-preview`." Followed that
advice exactly — `--matte auto --matte-preview` first (confidence 1.0, 21%
coverage, one piece), then the real forge with `--matte auto`. The plain-text
summary path worked cleanly: 52 triangles, 15KB, and `analyze` scored it
100/100 against `mobile-hero@3` with no findings. A real newcomer's five
minutes here would have gone fine end to end.

Reaching for `--json` instead of the summary line — the documented,
scriptable path an agent would actually use — did not go fine:

### L12 · `fixed` · `extrude --json --matte` serialized the internal per-pixel alpha channel, not a summary

`extrude <img> --matte auto --json` on the 512x512 icon produced a 4.8MB
JSON document — 262,155 keys, `"0": 0, "1": 0, ..., "262143": 0` — where the
non-`--json` path prints one clean line. Root cause (`packages/cli/src/
index.ts`): the forge branch did
`JSON.stringify({ outPath, bytes, ...stats })`, and `stats.matte` is the full
`Matte` object from `packages/core/src/extrude/matte.ts`, whose `alpha:
Uint8Array` (the synthesized per-pixel mask, kept for compositing) serializes
as one object key per pixel. The `--matte-preview` branch two cases above it
already knew to strip this (`...matte, alpha: undefined`) — the forge branch
just didn't do the same thing, so this reads as an oversight, not an
intentional inconsistency between the two JSON shapes.

Checked whether this reaches the MCP surface, which is the surface most
agents actually script against: it doesn't. `schemas/extrude_image.output.
json`'s `matte` object is hand-mapped to a fixed, `additionalProperties:
false` shape with no `alpha` field, and calling `extrude_image` directly over
stdio on the same image confirmed it — 13,344 bytes, not megabytes. So this
was CLI-only, on the one flag (`--json`) built for agents to parse.

Fixed by stripping `matte.alpha` in the forge branch the same way the
preview branch already does, one line. Added `packages/cli/test/
extrude.test.ts`: forges a synthetic 96x96 opaque-subject PNG (sharp, no
`Math.random`) through the built CLI with `--matte auto --json`, and asserts
`stdout.length < 2000` and `r.matte.alpha` is `undefined`. Confirmed it fails
without the fix — reverted `index.ts`, rebuilt, ran it: `expected 161268 to
be less than 2000` (161KB on a 96x96 source; the 512x512 icon was 4.8MB).
Restored the fix, rebuilt, reran: passes, output is 550 bytes on the icon.

`pnpm -r build && pnpm -r test`: all green (`packages/cli` 6 passed | 5
skipped, unchanged elsewhere). Probe before/after: identical shape, no
regressions, latency within normal run-to-run noise
(`optimize_glb` p50 2459ms → 2331ms, p90 3850ms → 3982ms); no baseline.json
change.

Left open: I did not touch `scaffold` (PR #29 already covers its
build/install path) or go further into "put it on a landing page" — the
extrude leg was where the friction was, and chasing scaffold too would have
overlapped #29's ground. L4 (`site/llms.txt` version line) is untouched, per
the standing instruction not to re-file it.
