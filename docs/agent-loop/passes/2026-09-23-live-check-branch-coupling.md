# Pass — 2026-09-23 — manual, from the maintainer's machine

Not a scheduled pass. A check on the loop's own health after ~40 hours found
the live check had been dead for seventeen of them.

### L9 · `fixed` · the live check died on a branch switch and said nothing for 17 hours

The launchd job ran `node scripts/live-check.mjs` against the **working
tree**. That script only exists on this branch, which is not merged, so the
moment `feat/animate-companion` was checked out the file was gone and the job
failed with `MODULE_NOT_FOUND` once an hour, silently, from
2026-09-22T07:44Z until it was noticed.

Two separate mistakes, and the second is the worse one.

Coupling a background monitor to whatever branch happens to be checked out
was wrong on its face — and specifically contradicted the reason the script
was written in plain Node with no build step, which was so it could "still
answer *is the site up* against a checkout that is mid-rebuild or broken".
It was never actually insulated from the checkout at all. It now resolves the
script from a **git ref** (`origin/main`, then this branch), extracts it to
`.agent-loop/live-check.mjs` — one level down, so the script's own
`dirname/..` repo-root calculation stays correct — and runs that. No edit
will be needed when the loop merges, because main is preferred.

The second mistake: **a monitor that cannot run also cannot tell you it is not
running.** Seventeen hourly failures produced no notification, because the
notification path is inside the script that was failing to load. Nothing here
fixes that in general — the launchd log now carries a specific message
instead of a Node stack trace, and the history file's last timestamp is the
thing to look at. A real dead-man's switch (alert when the newest history row
ages past ~3 h) is the honest fix and is not done.

One incidental trap worth writing down, since it cost a debugging cycle and
will cost the next person one: the wrapper runs under **zsh**, where
`"$ref:scripts/live-check.mjs"` parses `:s` as the *substitute* history
modifier and silently rewrites the ref to `…bootstrapk.mjs`. `git ls-tree`
showed the file present while `git cat-file -e` insisted it was absent. Braces
(`"${ref}:…"`) fix it. bash is unaffected, which is exactly why it survived
being tested by hand.

Verified after the fix: the job runs green from `feat/companion-hooks`, a
branch with no `scripts/` entry for it at all, and wrote a fresh history row —
six pages 200, both free Worker routes 200, two Studio assets resolved,
deployed `llms.txt` in step with `origin/main`, npm and repo both 0.8.0.
