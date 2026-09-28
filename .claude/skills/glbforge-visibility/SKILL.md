---
name: glbforge-visibility
description: Measure whether GLBForge is FOUND — ask AI engines (Perplexity, Google, and with the maintainer's browser Gemini/ChatGPT) the undirected questions a person types before they know the tool exists, score whether GLBForge surfaces, record a run, and open a PR only for a product-surface fix the run justifies. Use when asked to check discoverability / AI visibility / whether GLBForge gets recommended, or when the scheduled visibility probe fires.
---

# One GLBForge visibility probe

GLBForge is read before it is run, and it has to be *found* before it is read.
The info pass keeps the claims accurate; this asks a colder question: when
someone who does not yet know GLBForge exists asks an AI engine or a search box
the thing GLBForge is for, does GLBForge enter the answer? At the 2026-09-28
baseline it did not, on any undirected query. The apparatus exists to make that
number move and to prove when it has.

One pass, then stop. The question behind every decision: **would the tool now
appear when someone asks for what it does, without naming it?**

## Rules for the whole pass

- **Open a PR only for a change to the product surface** — copy on the landing
  page pitched at a phrasing that missed, a keyword set, a schema, a query the
  battery should add. **Never merge, never tag, never deploy.** Recording a run
  is not a PR by itself; it is committed evidence.
- **No paid path.** No Meshy, no fal, no Stripe. Read-only HTTP and public AI
  engines only.
- **Record what the engine said, in its words.** This repo's rule is that a
  message states what was measured. A visibility run that rounds a "mentioned in
  passing" up to "recommended" is the drift it was built to catch. An engine you
  could not reach (login wall, captcha, consent gate) is a *recorded* outcome,
  never a silent skip.
- **A run that surfaces no product fix still commits its run file.** The number
  moving on its own — because off-page work landed — is the result. Do not
  manufacture a copy change to justify the pass.

## 0. Nothing else is already on it

```bash
gh pr list --state open --json number,title,headRefName \
  --jq '.[] | select(.headRefName | startswith("discoverability/") or startswith("info-pass/"))'
```

Anything open that touches the landing page or `llms.txt` is claimed — this
pass and the info pass edit the same surfaces. Do not open a rival; leave a
review comment instead.

## 1. Read what is known

Read `docs/visibility/README.md` (the contract), `docs/visibility/ledger.md`
(the trend so far) and the most recent `docs/visibility/runs/*.md` (what each
engine actually said last time). Then `docs/visibility/queries.json` — the
frozen battery you are about to ask.

## 2. Ask the battery

Ask **every query in `queries.json` verbatim** so the numbers compare. Engines,
per the file's `engines` block:

- **Perplexity** — the primary, automatable engine. Drive it headless in the
  built-in browser (`mcp__Claude_Browser__*`): navigate to
  `https://www.perplexity.ai/search?q=<url-encoded query>`, decline optional
  cookies, wait for the answer, read it with `get_page_text`. No login.
- **Google** — read organic page 1 in the built-in browser
  (`https://www.google.com/search?q=...`) and note whether GLBForge appears and
  whether the AI Overview triggered. It is consent/login-gated and intermittent;
  record what you got.
- **Gemini / ChatGPT** — the login-gated chatbots, and the ones the maintainer
  reported getting wrong answers from. These need their logged-in session, so
  drive them in **Claude in Chrome** (`mcp__claude-in-chrome__*`, load via
  ToolSearch), not the isolated built-in browser. If Chrome is not available,
  record them as not-run — do not guess their answers.

For each answer capture: did GLBForge **surface** at all; was it **recommended**
(named among the tools the engine puts forward) or only mentioned; which domains
were **cited**; and for `named` queries, which of the query's `expect` features
were covered and which were wrong or missing.

## 3. Score and record

Score the three metrics in `README.md` (`undirected_surfaced`,
`undirected_recommended`, `named_correct`) as `k/n` over the queries you
actually asked in each class. Then write **one new file**,
`docs/visibility/runs/<YYYY-MM-DD>-<slug>.md`, in the shape the baseline uses and
the generator parses (`# Visibility run — <date> — <slug>`, `**Engines:**`, a
`## Scores` table of `metric | k/n | note`, a `## Results` table of the
per-query evidence). Never edit another run's file. Then:

```bash
pnpm visibility            # regenerate docs/visibility/ledger.md
pnpm visibility --check    # confirm it is in step (CI runs this)
```

## 4. Turn a miss into a product fix (only what the evidence supports)

A miss on an undirected query is a lead, not a mandate to rewrite the site.
Prefer, in this order:

- A phrasing that missed and has **no answer on the landing page or in
  `llms.txt` in those words** — add a plain-language answer (an FAQ entry, a
  section) that names GLBForge and the command, without version numbers or tool
  counts that will drift. Match the measured, adjective-free voice.
- A **structured-data or keyword** gap — `SoftwareApplication` / `FAQPage`
  JSON-LD on `site/index.html`, `robots.txt` / `sitemap.xml`, npm `keywords`
  that cover the phrasing.
- A **battery** gap — a real query class nobody is asking. Add it to
  `queries.json` and say why in the run file.

`site/index.html` is a checked surface: after editing it run `pnpm docs:check`
(it keeps the tool count honest) and open it in the browser pane to confirm no
markup leaked and the JSON-LD still parses. Never hand-edit a generated file
(`site/budgets/index.html`, the profile tables in `docs/BUDGETS.md`).

The highest-leverage work is **off-page** — ecosystem lists (awesome-gltf,
awesome-webgl, three.js resources), the threads where these tools get
recommended, comparison posts — and it is not this pass's to publish: it carries
the maintainer's identity and voice. Draft it if asked and leave it in the run
file as a queue; do not post as them.

## 5. Open the PR (if there is one)

Branch `discoverability/<yyyy-mm-dd>-<slug>`. The description carries: the run's
scores and the trend line they extend, which phrasings missed, what changed on
the product surface and why that answers the miss, and the `pnpm docs:check`
output. Attach or link the run file. Then stop — no merge, no tag, no deploy.
