# Workstream B — getcrosscode.dev landing page copy + above-the-fold pass

Repo: crosscode (pnpm monorepo). Static Vite site. This is a copy and layout pass. No JS
behavior changes, no auth changes.

## Files (the only files you may read or edit)

Edit:
- `apps/docs-site/index.html` — the landing page (hero starts ~line 82).
- `apps/docs-site/src/style.css` — only the hero/agents-section rules you need for the
  above-the-fold requirement.

Read only (do not edit):
- `apps/docs-site/src/seo.test.ts`, `apps/docs-site/src/a11y.test.ts` — these are your
  guardrails; understand what they assert before you touch `<head>`.

Nothing else. Do not run repo-wide greps.

## Goal

The first screen should lead with the concrete outcome, and the install command plus the
"works with" agent list must both be visible without scrolling on desktop and mobile. Every
honesty section stays exactly as candid as it is now.

## Required changes

1. **Hero headline + subheadline (`index.html` ~line 91-97).** Sharpen to lead with the
   outcome, not the mechanism. Current:
   - h1: "Your teammate's edit, already in your checkout"
   - lede: "Everyone works in their own checkout with their own coding agent. Crosscode
     sends each edit to whoever is on the same branch once it settles, and applies theirs
     to your working tree the same way. Nobody presses anything."

   Rewrite so the reader's takeaway is the outcome: a teammate edits, your checkout
   updates, no manual pulling, no pasting files between agents, nobody overwrites anyone.
   This is a **framing pass only** — every claim must already be true of the product as
   described elsewhere on this page. Do not add speed numbers, percentages, team sizes, or
   any metric not already in the file ("within seconds" and the existing "roughly 95%"
   figure are already on the page and may be reused as-is). Keep the `class="reveal"` and
   `class="lede hero-lede reveal"` attributes intact — JS animation depends on them.

2. **Above the fold, both widths.** After your copy edit, the `npm install -g
   crosscode-cli` command (`.hero-cmd`, ~line 107) and the agent chip list
   (`section.agents`, ~line 200) must both be fully visible without scrolling at:
   - desktop 1440x900
   - mobile 390x844 (iPhone 14 class)

   The animated `.stage` demo block currently sits between them (~line 120-196) and will be
   what pushes the chips down. Solve it however is cleanest and least invasive — the
   preferred approach is to move `section.agents` up so it sits directly after the
   `.hero-inner` block and before the `.stage` wrapper, with a compact treatment (smaller
   kicker, tighter chip row) so it fits. Do NOT delete the `.stage` demo, do not delete any
   chips, and keep the chip list accurate — the current 10 agents + "any MCP client" are
   correct, do not add an agent that isn't supported. Tighten hero vertical spacing in
   `style.css` if needed, and check the existing mobile media queries rather than adding a
   competing one.

3. **Do not touch these sections, at all, beyond leaving them where a reader still reaches
   them:** `#privacy` ("We can read the files you sync"), `#pricing` ("Free, with no paid
   plans yet"), `#status` ("where things stand" limitations), `#safety` ("Five rules it
   will not break"), and the FAQ `#faq` — including the "is it worth it for one person?
   No" answer. No softening, no shortening, no moving them below the footer, no collapsing
   them behind a `<details>`. They may keep their current order and position.

4. **`<head>` metadata (lines 6-7).** The `<title>` and `<meta name="description">` must
   still contain both the exact strings `Crosscode CLI` and `MCP`. You may polish the
   wording, but if you do, keep both strings and keep the description unique across the
   site (see `seo.test.ts` — it asserts uniqueness of titles, descriptions and canonicals
   across 26 pages). Safest option: leave `<head>` untouched, and just verify.

5. **Social proof.** There is no testimonials or social-proof section on this page. Do not
   create one. Do not add user counts, download counts, logos of companies, or quotes.
   Report in your writeup that none exists.

## Out of scope — do not touch

- `apps/docs-site/auth/**`, `apps/docs-site/join.html`, `apps/docs-site/device.html`,
  `apps/docs-site/api/**`, `src/main.js`, `src/join.js`, `src/device.js`, `src/analytics.js`.
- Anything about GitHub OAuth, sign-in, device codes, Stripe, or billing — including the
  header sign-in links.
- Any `docs/**` page or `scripts/generate-docs.mjs`.
- Do not commit, push, merge, rebase, or open a PR. Leave changes uncommitted.

## Verify (run these yourself)

```bash
# 1. SEO + a11y suites must stay green.
cd /Users/a.m.sultan/orca/workspaces/crosscode/marketing-landing
pnpm vitest run apps/docs-site/src/seo.test.ts apps/docs-site/src/a11y.test.ts

# 2. Head metadata keeps both SEO terms.
grep -n 'Crosscode CLI' apps/docs-site/index.html | head -3
grep -c 'MCP' apps/docs-site/index.html

# 3. Every honesty section still present.
grep -n 'id="privacy"\|id="pricing"\|id="status"\|id="safety"\|id="faq"' apps/docs-site/index.html
grep -n 'no end-to-end encryption\|We can read the files you sync' apps/docs-site/index.html
grep -in 'worth it' apps/docs-site/index.html      # the one-person answer must still be "No"

# 4. Above the fold, measured — not eyeballed. Use Orca's browser, NOT claude-in-chrome.
pnpm --filter @crosscode/docs-site dev &      # serves on a vite port; note the port
orca tab create
orca goto http://localhost:<port>/
orca set device --width 1440 --height 900
orca eval 'const cmd=document.querySelector(".hero-cmd").getBoundingClientRect(), chips=document.querySelector(".agents .chips").getBoundingClientRect(); JSON.stringify({vh:innerHeight, cmdBottom:cmd.bottom, chipsBottom:chips.bottom, bothVisible: cmd.bottom<=innerHeight && chips.bottom<=innerHeight})'
orca screenshot
orca set device --width 390 --height 844
orca eval '<same expression>'
orca screenshot
```

Expected: `bothVisible: true` at BOTH 1440x900 and 390x844, both suites pass, all
disclosure greps hit. Attach/describe both screenshots in your report.

## Done means

`bothVisible: true` at both widths, `seo.test.ts` and `a11y.test.ts` pass, every grep in
step 3 hits, and `git status` shows only `apps/docs-site/index.html` and
`apps/docs-site/src/style.css` modified.

## Report back

The verify output (including both `orca eval` JSON results), `git diff --stat`, what you
changed in the hero copy (quote the old and new h1/lede), and anything you could not do.

# Workstream A — README marketing restructure

Repo: crosscode (pnpm monorepo). You are a copy/structure pass on ONE file. No code changes.

## Files (the only files you may read or edit)

- `README.md` — the only file you edit.
- You may read (do not edit): `apps/docs-site/index.html` (for the accurate "Works with"
  agent list, which is a `<ul class="chips">` around line 203), `docs/privacy.md`,
  `PLAN.md`. Nothing else. Do not run repo-wide greps.

## Goal

Make the first screen of the README sell the product, without changing a single factual
claim. Everything already in the README is accurate — this is reordering and tightening,
not new claims.

## Required changes to README.md

1. **Top of file, in this order:**
   - Logo + `Crosscode` h1 (keep as-is).
   - Badge row. Keep the existing npm version, CI, stars, MIT, and Node 24 badges, and
     ADD a shields.io weekly-downloads badge for the real package:
     `https://img.shields.io/npm/dw/crosscode-cli?style=flat&color=08C&label=downloads`
     linked to `https://www.npmjs.com/package/crosscode-cli`. Match the existing
     `style=flat&color=08C` look. The MIT badge must link to `./LICENSE` (currently it is
     an unlinked img — make it a link, keep the same shields.io URL).
   - The one-line value prop as the headline sentence, in the spirit of:
     "Real-time codebase sync between teammates and coding agents, so nobody overwrites
     anyone else's work." Keep the existing follow-on sentences ("You edit a file, their
     checkout updates within seconds..."). Do not overclaim beyond what the current text
     says.
   - **A demo GIF placeholder.** No GIF exists in this repo. Do NOT invent one, do not
     reference a file that isn't there, and do not describe a recording as if it exists.
     Insert an HTML comment placeholder, clearly marked, e.g.:
     ```html
     <!-- TODO(abdullah): record a ~10s screen capture of a sync landing in a second
          checkout (edit on the left, file updating on the right), save it as
          assets/demo.gif, and replace this comment with:
          <p align="center"><img src="assets/demo.gif" alt="A file edit in one checkout appearing in another within seconds" width="720" /></p>
     -->
     ```
     Nothing rendered should imply a GIF is present.
   - The one-command install immediately under that placeholder — a fenced bash block with
     exactly `npm install -g crosscode-cli` as the first line. It is fine that the fuller
     Quickstart block later also contains it; the top one is the hook.
   - The "Works with the agent you already run" section, moved up here (currently at
     line ~197). Use the accurate list from the site's chips: Claude Code, Codex CLI,
     OpenCode, Cursor, Gemini CLI, VS Code, Amp, Cline, Zed, Windsurf, + any MCP client.
     Verify against `apps/docs-site/index.html` and match it exactly.

2. **Keep the `> [!IMPORTANT]` disclosure block** (no end-to-end encryption, the service
   can read your files, PLAN.md status) — but move it BELOW the first screen, i.e. after
   the install + Works-with block, rather than deleting or softening it. Not one word of
   it may be weakened. It must still be prominent (keep the `[!IMPORTANT]` callout
   styling), just not the first thing above the fold.

3. **Reorder the body** so it reads top-to-bottom as:
   1. What it does — `How it works`, `Features`
   2. How to install it — `Quickstart`
   3. Why it's safe to trust — `What syncs, and what never does`, `The apply rule`
      (which contains the rules-it-won't-break list), `Pricing`
   4. Deeper detail for the curious — `What your agent sees`, `What Crosscode is not`,
      `Developing`, `Community and support`, `License`, `Trademark`

   Move whole sections. Do not rewrite section bodies except for minimal transition
   fixes (e.g. a heading rename, or a sentence that now points backwards instead of
   forwards). Every honest disclosure stays verbatim: the no-end-to-end-encryption
   sentences, what the service stores, the free-no-paid-plans pricing status, and the
   "What Crosscode is not" section.

## Out of scope — do not touch

- Any file other than `README.md`.
- Anything about GitHub OAuth, sign-in, device codes, Stripe, or billing. The sign-in
  paragraph in Quickstart stays exactly as written.
- No new features, metrics, user counts, star counts, testimonials, or benchmark claims.
  If a number is not already in the file, do not add it.
- Do not delete the CI badge, the stars badge, or any docs link.
- Do not commit, push, merge, rebase, or open a PR. Leave changes uncommitted in your
  worktree.

## Verify (run these yourself)

```bash
# 1. The install command is in the first 60 lines, and no fake GIF is referenced.
head -60 README.md
grep -n 'demo.gif' README.md          # expect: only inside the TODO comment
ls assets/ | grep -i gif || echo "no gif present (expected)"

# 2. Every disclosure survived, byte-for-byte on the key phrases:
grep -c 'no end-to-end encryption' README.md        # expect 2 or more
grep -n 'The hosted service is free' README.md
grep -n 'What Crosscode is not' README.md
grep -n 'docs/privacy.md' README.md

# 3. No links were dropped. Compare the set of link targets before and after:
git stash && grep -o '](\./[^)]*)' README.md | sort -u > /tmp/cc-links-before.txt
git stash pop && grep -o '](\./[^)]*)' README.md | sort -u > /tmp/cc-links-after.txt
comm -23 /tmp/cc-links-before.txt /tmp/cc-links-after.txt   # expect: EMPTY output

# 4. Badge URLs resolve (npm downloads badge is real):
curl -sS -o /dev/null -w '%{http_code}\n' 'https://img.shields.io/npm/dw/crosscode-cli'
# expect 200
```

Expected result: install command visible in the first screen, comm output empty, all
disclosure greps hit, no GIF file referenced outside the TODO comment.

## Done means

All four verify steps produce the expected output, and `git status` shows `README.md` as
the only modified file.

## Report back

The verify command output, `git diff --stat`, and anything you could not do.

## Ground rules (non-negotiable)

Read only what this brief lists. If you need a file outside that list, stop and say so
rather than exploring. Do not run repo-wide greps. Do not spawn subagents. Do not merge,
rebase, commit, push, or touch any branch but your own. Leave your work uncommitted.

This `BRIEF.md` file itself is untracked scaffolding — ignore it in your file-count check
and do not commit or delete it.

Any web/browser work uses Orca's browser (`orca tab create` / `goto` / `screenshot` /
`eval`), never claude-in-chrome and never `browse`.

Report at the end: your verify command output, `git diff --stat`, and anything you could
not do or chose not to do.
