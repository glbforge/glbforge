# Pass — 2026-09-24 — 09397cd
**Role:** saboteur

## Step 0 — claim check

`list_pull_requests` (no `gh` in this sandbox; used the GitHub MCP tools)
showed nine open PRs. Seven carry `agent-loop/`-prefixed branches and claim
every never-used role from `pnpm ledger`'s rotation on `main`: `#28` rival,
`#29` integrator, `#30` performance, `#31` archaeologist, `#32` newcomer,
`#34` newcomer-to-new-code. `#20` (`agent-loop/2026-09-23-companion-reply-id`)
is a stale leftover — its pass file is already merged into `main` directly
(commit `af49631`), so it claims nothing new. Two more (`#35`, `#36`) are
`fix/`-prefixed, not part of this loop's convention, and cover USDZ skeleton
export / draw-call promises — unrelated ground, left untouched either way.

With every role `pnpm ledger` would hand me already spoken for, I took the
next one down by the same least-recently-used ordering: **saboteur** (one
prior pass, 2026-09-23; `auditor` has nine and would be worse to pick again).

## Ground truth

`pnpm install && pnpm -r build`: clean, six packages. `pnpm -r test`: 175/178
core (3 skipped, LFS), 44/44 mcp, 5/10 cli (5 skipped, LFS), 2/2 studio — all
green before any change. `pnpm probe -- --no-live`: 28 tools, no baseline
regressions, the one known open item (`site/llms.txt`'s 0.9.0 line, L4 — a
release call, left alone per the standing instruction).

## Saboteur work

Tried cyclic scene graphs first (`node.children` pointing at an ancestor, and
a node listing itself): confirmed dead end, evidence kept short — read the
loaded `Document` directly and `gltf-transform`'s own JSON reader already
refuses to link a child that would close a cycle, silently dropping the edge
before GLBForge's un-guarded `report.ts` depth-walker (`extent.ts`'s sibling,
no visited-set) ever sees one. Not a finding; noted here so the next saboteur
doesn't re-spend a pass on it.

Moved to numeric corruption: a triangle with a `NaN` in exactly ONE
component of ONE vertex (X and Z finite, Y is `NaN`) — the kind of thing a
divide-by-zero in a scale op or a bad DCC export produces, not an exotic
attack.

**Confirmed: this broke the MCP envelope contract itself, on the tool
described as "call this after EVERY edit."** `inspect` and `diff` on such a
file didn't return `ok:false` with a diagnostic — they returned `isError:
true` with `content[0].text` set to a *plain-text SDK message*
(`MCP error -32602: Output validation error: ... Unrecognized key(s) in
object: 'path', 'format', ... at data`), not the `{ok, summary, duration_ms,
errors, data}` JSON every other failure path in this codebase guarantees
(`envelope.ts`'s own docstring: "exceptions become ok:false envelopes...
never throws into a tool"). Any caller that trusts that contract and does
`JSON.parse(raw.content[0].text)` — including this repo's own MCP test
harness's `call()` helper — throws a raw `SyntaxError`, i.e. exactly the
"stack trace escaping into an agent's transcript" the saboteur role exists
to catch, on input that isn't even malicious-looking.

**Root cause**, once isolated from the MCP layer with a direct Zod parse
(the SDK's own error message was a red herring — see below):
`packages/core/src/inspect/extent.ts`'s `sceneExtent()` builds bounds with
`if (v[a] < min[a]) min[a] = v[a]; if (v[a] > max[a]) max[a] = v[a]; sum[a]
+= v[a];` per axis. A `NaN` component correctly fails both comparisons
(`NaN < Infinity` is `false`), so min/max silently skip it — but `sum[a] +=
v[a]` ran unconditionally, so `sum` picked up the `NaN` regardless of which
axis carried it. The function's own finiteness guard (`!Number.isFinite(
min[0])`) only checks whether bounds exist at all; it can't see a poisoned
`sum` when the OTHER axes still have real bounds. `classifyOrigin()`'s
`distance_to_centroid_m = Math.hypot(...)` then comes out `NaN`, and Zod's
`z.number()` — used for `OriginPlacement.distance_to_centroid_m`, non-
nullable by design in `diff@1`'s schema, since it's supposed to always be a
real distance — correctly rejects `NaN` (confirmed directly: `DiffDataSchema
.safeParse()` reports the honest `invalid_type: expected number, received
nan` at the exact path). The SDK's own confusing "unrecognized key(s) in
object: data" text is an artifact of `envelopeShape()`'s `data: dataSchema
.or(z.object({}).strict())` union: when the real schema fails, Zod retries
the "empty object, only valid when ok:false" branch and surfaces THAT
branch's failure instead, discarding the useful one. Separate, smaller
rough edge — not fixed here, since the real fix (never producing `NaN` in
the first place) makes it moot for this case, and touching the union's
error-reporting behavior risks changing what every OTHER tool's `ok:false`
path looks like.

**Fixed**: a vertex with a non-finite value on any one axis is now dropped
from `sceneExtent()` entirely (all three axes, not just the poisoned one),
so a corrupt vertex can no longer contribute to `min`/`max` on the axes that
happened to look finite while poisoning `sum` on the others. `distance_to
_centroid_m` (and everything else this feeds) is now always a real number,
or `sceneExtent` returns `null` when every vertex is corrupt — never a
silent `NaN`. Two call sites affected: `inspect`'s `origin` (already
nullable, but was silently getting `NaN`-that-serializes-as-`null` instead
of an honest bounding box) and `diff`'s `origin.before`/`origin.after`
(non-nullable — this is the one that actually broke the SDK contract).

**Left open, deliberately not fixed**: non-finite vertices are now silently
excluded from bounds/centroid with no diagnostic — an asset with one
corrupt vertex among a thousand good ones reports a clean, plausible bounding
box with no signal that anything was dropped. `scene.vertices` in the report
still counts it (that comes from accessor length, not `sceneExtent`), so the
undercount is invisible. Surfacing it needs a new diagnostic code raised at
IR-construction time (`from-gltf.ts`/`from-usd.ts`, alongside
`BUFFER_UNRESOLVED`-style load diagnostics), which means iterating every
vertex a second time on every load — a real perf question, not just a
one-line addition — and I didn't want to make that call unilaterally in a
pass whose evidence only demanded "stop the crash." Worth an `archaeologist`
or another `saboteur` look.

## Verify

`pnpm -r build && pnpm -r test`: 176/179 core (3 skipped, +1 test), 45/45 mcp
(+1 test), 5/10 cli (5 skipped), 2/2 studio — all green. Reverted just
`extent.ts` (`git stash push -- packages/core/src/inspect/extent.ts`) and
reran both new tests to confirm they fail without the fix: the core test
gets a non-finite `distance_to_centroid_m`, the mcp test reproduces the
exact `SyntaxError: Unexpected token 'M', "MCP error "... is not valid JSON`
found live. Restored the fix, rebuilt, reran — both pass. `pnpm probe --
--no-live`: identical tool count, identical advice/vocab/schema-violation
counts, latency within this host's normal noise. No `baseline.json` change.

### L12 · `fixed` · a vertex with a `NaN`/`Infinite` component on one axis broke the MCP envelope contract for `inspect` and `diff`

Measured: `packages/core/src/inspect/extent.ts`'s `sceneExtent()` summed a
non-finite vertex component into the centroid (`sum[a] += v[a]`)
unconditionally, even on axes where the per-axis min/max comparison
correctly skipped it — `NaN < Infinity` and `NaN > -Infinity` are both
`false`. This let `distance_to_centroid_m` (`classifyOrigin()`, via
`Math.hypot`) come out `NaN` while the reported bounding box still looked
entirely plausible. Because that field is `z.number()` (non-nullable) in
`diff@1`'s output schema, and effectively the same via `z.number().
nullable()` for `inspect` (`NaN` satisfies neither — Zod rejects `NaN`
outright, confirmed with a direct `.safeParse()`), the MCP SDK's own
output-schema validation rejected the response and returned `isError: true`
with a plain-text SDK error string instead of this codebase's `{ok, summary,
duration_ms, errors, data}` JSON envelope — breaking `JSON.parse` for any
caller that trusts the documented "every tool answers with the envelope"
contract, demonstrated on `inspect` (described as the after-every-edit call)
and `diff`. Fixed in `sceneExtent()`: a vertex with a non-finite value on any
axis is now excluded from `min`/`max`/`sum`/`count` entirely, so a partially-
corrupt vertex can no longer poison the centroid while looking clean on
other axes. Regression tests: `packages/core/test/core-scene.test.ts`
(`sceneExtent`/`classifyOrigin` stay all-finite, and an all-`NaN` mesh
reports `null` bounds rather than `NaN` ones) and
`packages/mcp/test/inspect.test.ts` (the actual MCP surface, both `inspect`
and `diff`, on a file with exactly one corrupt vertex component) —
confirmed both fail against the unfixed code, the mcp one reproducing the
live `SyntaxError`. Left `open`, not `fixed`: non-finite vertices are now
silently dropped from bounds with no diagnostic telling the caller a vertex
was excluded — a smaller, separate gap noted above, not chased in this pass.
