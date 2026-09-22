# Agent tasks

Random end-to-end tasks an agent might bring to GLBForge, walked as that agent
would walk them, and the feedback each walk produced. The agent loop's probe
grades `nextActions` mechanically; this is the judgement half: **every place
the agent had to guess, open a file, or already know something is a defect.**

```bash
pnpm random-task                    # draw today's task (seed = the date)
pnpm random-task -- --seed 7        # redraw a specific one
pnpm random-task -- --seed 7 --json
```

A draw combines a source (an example GLB, a PNG, a photo, an SVG, a raw
generator download), a goal (web hero, AR, print, desktop companion, change
review, configurator), one constraint and one twist. The seed is cited in the
walk so another pass can redo it after a fix.

One file per walk in this directory, `<date>-<slug>.md`: the draw, the step
table with a verdict per step (`clear` / `guessed` / `opened-a-file` / `knew`
/ `wrong` / `slow`), then findings in the ledger's shape. Findings that get
fixed say so in the same file; the agent-loop ledger picks up `L` ids only —
task findings use `T` ids and stay here.

| Walk | Seed | Draw | Findings |
|---|---|---|---|
| [2026-09-22 badge → companion](2026-09-22-badge-companion.md) | 20260922 | transparent PNG → idle + reaction clip → desktop companion; profile pinned; every number from a tool | T1–T7 |
