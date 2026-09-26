# Pass — 2026-09-26 — cdccee8, scheduled, cloud sandbox

A second info pass the same day, on top of the maintainer's manual one
(`90fb813`, [2026-09-26-info](2026-09-26-info.md)) that closed L12–L14.
`pnpm install && pnpm -r build` and `pnpm docs:check` were both clean before
and after. Re-read `CHANGELOG.md`'s Unreleased section, `ROADMAP.md`'s
checked boxes, and this ledger against `site/index.html`, `site/llms.txt`,
`README.md` and `packages/mcp/README.md`: `--matte auto`, matte preview and
tolerance sweep, `animate`, the desktop companion (including the embedded
brain, the external-brain MCP bridge, and `--hooks`) are all already
described everywhere a reader of that surface would look — the morning pass
covered the real drift. No paid path touched (no Meshy, no fal, no Stripe);
`scripts/live-check.mjs` was not run here, per L7.

One thing left the ledger out of step with the code: L4.

### L4 · `fixed` · `site/llms.txt` claims main is "the 0.9.0 line"; every package is 0.8.0

Re-checked against the source rather than trusted from the table: line 15 of
`site/llms.txt` currently reads "the 0.8.0 line," matching every package's
`version` field. The fix landed as a side effect of `a8a921e` ("Generate the
information surface, and gate what cannot be generated"), which is also the
commit that built `scripts/docs-sync.mjs` — it added a mechanical check
(`docs-sync.mjs:273-282`) that parses the "the X.Y.Z line" sentence out of
`llms.txt` and gates when it disagrees with the packages' version, so this
specific drift cannot recur silently. Nobody closed the ledger row when that
landed, so it still read `open` with `last touched` 2026-09-21, a full pass
before the fix. Carrying a resolved finding as open costs a future pass
nothing today, but the ledger's whole purpose is to answer "is this still
true" without re-deriving it — so it is worth one line to say it no longer
is.
