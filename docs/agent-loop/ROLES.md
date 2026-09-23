# Roles

A pass picks a role before it picks a task, and the role decides what counts
as a good pass.

This exists because the loop had exactly one stance — auditor — and an auditor
that has already audited everything reports "nothing to fix", correctly,
forever. Four consecutive passes did precisely that. The ground had not gone
quiet; the loop had only one way of looking at it.

Each role below succeeds differently. An **auditor** succeeds by finding
nothing. A **saboteur** succeeds by finding a crash. A **rival** succeeds by
producing an honest table in which GLBForge sometimes loses. Judging one by
another's standard is how a loop starts lying to itself.

## Picking one

Take the role **least recently used** — `pnpm ledger` prints the rotation.
Deterministic, so coverage evens out without anyone tracking it, and no two
consecutive passes share a stance. Declare it on the second line of your pass
file:

```markdown
# Pass — 2026-09-23 — <commit or run id>
**Role:** saboteur
```

If the least-recent role genuinely cannot run this pass — the saboteur needs
`sharp` and it will not build, say — take the next one and write down why you
skipped it. Skipping to get an easier role is the one move that breaks this.

---

## auditor

The original stance. Run the probe, check every published claim against the
code, look for drift between `schemas/`, `docs/error-codes.md`, the MCP
README, `site/llms.txt` and what the server actually does.

**Succeeds by finding nothing**, and says so. Do not manufacture a finding.
This role saturates fastest, which is the whole reason for the others.

## newcomer

Arrive with no context. Pick a real job someone would actually want — "get
this logo onto a landing page in 3D", "make this Meshy download load on a
phone", "put a character in AR" — and do it **using only what the tools
return**. No reading source, no prior knowledge.

Every place you had to guess, open a file, or already know something is a
defect. Record where you got stuck and what you needed, not what you would
change — the fix is a separate judgement and often belongs to someone else.

This is the role that found the Studio's first minute was broken.

## saboteur

Try to break it, on purpose, from outside. Truncated GLBs, a PNG renamed
`.glb`, a 4-byte file, zero-triangle meshes, NaN and infinite positions,
degenerate UVs, a 400MB texture, deeply nested nodes, cyclic references,
hostile filenames, unicode paths, a GLB whose JSON chunk lies about lengths.

**Succeeds by finding a crash, a hang, or — worse — a confident wrong
answer.** A stack trace escaping into an agent's transcript is a bug even when
the input deserved it: the envelope exists so every failure arrives as a code.

Attack the tool's own inputs only. Not the network, not the host, not
anybody's data.

## rival

Take one real asset through GLBForge and through an alternative —
`gltfpack`, `gltf-transform` CLI, Blender's exporter, `usdzconvert` — and
compare on numbers: bytes, triangles, draw calls, SSIM, wall-clock.

**Succeeds by publishing a table in which GLBForge sometimes loses.** A
comparison that always flatters us is a comparison nobody should trust, and
the losses are the only rows with information in them. If a rival will not
install in the sandbox, say so and compare against published numbers instead
of inventing them.

## integrator

Wire GLBForge into something real and watch the seams: a Next.js route, a
model-viewer page, a Blender round-trip, the GitHub Action in a throwaway
repo, the MCP server in a client that is not this one.

**Succeeds by finding what breaks at the boundary** — the thing that works
perfectly alone and fails the moment it has a neighbour.

## performance

The inner-loop reframe is a latency bet: `inspect` is the call you make after
every edit, and it stops being that if it creeps. Profile the hot paths,
measure before and after, and defend the numbers in `baseline.json`.

**Succeeds by making something measurably faster, or by proving the bet still
holds.** Never trade determinism for speed — same input, same bytes, same
pixels is not negotiable.

## archaeologist

Read the closed findings, the `wontfix`es, the `watching`es and the unchecked
ROADMAP boxes, and ask whether the reasons still hold. Dependencies move,
formats gain loader support, a thing deferred for good reason six months ago
may be cheap today.

**Succeeds by reopening something that deserves it, or by confirming a
deferral is still right** — with the reason restated in today's terms, not
last quarter's.

## newcomer-to-new-code

Whatever shipped most recently and has not been read by anyone but its author.
`git log main` since the last pass with this role names it.

**Succeeds by reviewing new ground before it calcifies.** A pass reached for
this on its own when the companion landed — which is the clearest evidence the
roster needed writing down.
