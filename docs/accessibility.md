# Accessibility

This statement covers **www.getcrosscode.dev** — the landing page, the docs, and the
sign-in, join, and device pages. It does not cover the `crosscode` CLI, the daemon, or the
MCP server, which are terminal programs and inherit whatever your terminal and screen
reader already do.

## The standard we aim at

**WCAG 2.2, level AA.** That is what we test against and what we fix to.

## Where we actually are

**Partially conformant.** Every page passes the automated checks described below, and the
checks we could run by hand pass too. We have not run this site with a screen reader end
to end, so we cannot claim full conformance, and we are not going to claim it.

What we have verified, on the landing page, all twelve docs pages, and the sign-in,
sign-up, join, and device pages — in the case of the last four, in every state they can
render, including their error states:

- No `axe-core` violations at WCAG 2.2 AA, plus axe's best-practice rules, in a real
  browser and in the test suite.
- Every page on the site, including the password-reset and CLI-login pages, has a skip
  link that points at its `<main>`. Every page scanned has one `<h1>` and heading levels
  that do not skip.
- All text meets 4.5:1 contrast (3:1 for large text) against the background actually
  composited behind it. Interactive control borders — input boxes, button outlines —
  meet 3:1.
- No horizontal scrolling at a 320px-wide viewport, or at 200% zoom.
- Every clickable target is at least 24×24px, except links sitting inside a sentence,
  which WCAG exempts.
- Tab order follows the document order. There are no positive `tabindex` values and no
  focus traps. Focus is drawn as a 2px white outline, which is 21:1 against the page.
- Form fields have real labels. Sign-in and password-reset errors are announced through a
  live region rather than being written into a hidden element, and the fields are marked
  `aria-invalid` when a submission fails. Errors are conveyed in words, not by colour.
- The animated diagram on the landing page has a Pause button and stops entirely under
  `prefers-reduced-motion`.

## Known limitations

These are real, and we would rather list them than let you find them.

1. **No screen reader pass.** We checked the accessibility tree the browser exposes to
   assistive technology, which is what a screen reader reads from, but we have not driven
   the site with VoiceOver, NVDA, or JAWS from start to finish. Something can be correct
   in the tree and still be awkward to hear.
2. **No pass by a disabled user, and no third-party audit.** Everything below was done by
   the person who wrote the site.
3. **One theme.** The site is dark only. There is no light theme, and we have not tested
   Windows High Contrast / `forced-colors` mode at all.
4. **Code blocks have no name.** Wide code samples scroll sideways and are keyboard
   focusable so you can scroll them with the arrow keys, but they announce as an unnamed
   region rather than "code sample, bash".
5. **The sign-in journey was tested as markup, not as a journey.** GitHub sign-in cannot
   complete yet (see the [limitations page](/docs/limitations.html)), so the signed-in,
   terminal-bound, and invite-accepted screens were audited as the markup those states
   render, not by walking through them for real.
6. **Automated testing finds a minority of problems.** `axe-core` detects perhaps a third
   to a half of WCAG failures. Zero violations means zero violations of the rules it can
   check, not zero problems.
7. **Two pages were only checked structurally.** `/auth/reset.html` and `/auth/cli.html`
   build themselves from scripts that need live credentials to run at all, so they were
   checked for skip link, language, and title, and their form markup matches the sign-in
   form that was scanned — but they have not been through `axe-core` as rendered.
8. **We do not target level AAA**, and there is no plan to.

## Tell us about a barrier

Email **support@getcrosscode.dev**. Say what page you were on, what you were trying to
do, and what you use — the browser, the screen reader, the magnification, whatever is
relevant. A description of what went wrong is enough; you do not need to know which WCAG
criterion it was.

**What happens then:**

- We acknowledge within **5 working days**.
- If the barrier stops you installing Crosscode or signing in, we aim to fix it or give
  you a working alternative within **30 days**, and tell you if that is going to slip.
- Anything else goes on the list. We will tell you whether it is queued or declined, and
  why, rather than leaving you without an answer.

Crosscode is a one-person, pre-1.0 project. That is not an excuse for a barrier, but it is
the reason the promise above is 5 days and 30 days rather than something faster.

## How this was assessed

- **Last assessed:** 6 August 2026.
- **Assessed by:** {{PROVIDER_NAME}}, self-assessment.
- **Automated tool:** `axe-core` 4.13, run at tags `wcag2a`, `wcag2aa`, `wcag21a`,
  `wcag21aa`, `wcag22aa` and `best-practice`. Run two ways: in a real Chromium browser
  against every built page, and in the repository's test suite (`apps/docs-site/src/a11y.test.ts`)
  against every page and every state the sign-in, join, and device pages can render. The
  suite runs on every `pnpm test`, so a regression fails the build rather than waiting for
  the next audit.
- **Manual checks:** contrast computed from the browser's own resolved colours against the
  composited background, for every text node on every page; reflow at a 320px viewport and
  at 200% zoom; target sizes measured from live layout; tab order and focus styling read
  from the DOM and the stylesheet; the accessibility tree inspected on the sign-in, join,
  and device pages.
- **Not done:** screen reader testing, `forced-colors` testing, and any testing with
  assistive technology other than the browser's own accessibility tree.

The next assessment is due whenever the site's markup changes materially, and the
regression suite runs in the meantime.

## Before this takes effect

Fill these in:

- `{{PROVIDER_NAME}}` — the legal name of the individual who publishes Crosscode, used
  above under "Assessed by".
