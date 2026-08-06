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
