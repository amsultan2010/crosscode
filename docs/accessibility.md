# accessibility

this statement covers **www.getcrosscode.dev**: the landing page, the docs, and the
sign-in, join, and device pages. it does not cover the `crosscode` cli, the daemon, or the
mcp server, which are terminal programs and inherit whatever your terminal and screen
reader already do.

## the standard we aim at

**wcag 2.2, level aa.** that is what we test against and what we fix to.

## where we actually are

**partially conformant.** every page passes the automated checks described below, and the
checks we could run by hand pass too. we have not run this site with a screen reader end
to end, so we cannot claim full conformance, and we are not going to claim it.

what we have verified, on the landing page, all twelve docs pages, and the sign-in,
sign-up, join, and device pages, in the case of the last four, in every state they can
render, including their error states:

- no `axe-core` violations at wcag 2.2 aa, plus axe's best-practice rules, in a real
  browser and in the test suite.
- every page on the site, including the password-reset and cli-login pages, has a skip
  link that points at its `<main>`. every page scanned has one `<h1>` and heading levels
  that do not skip.
- all text meets 4.5:1 contrast (3:1 for large text) against the background actually
  composited behind it. interactive control borders (input boxes, button outlines)
  meet 3:1.
- no horizontal scrolling at a 320px-wide viewport, or at 200% zoom.
- every clickable target is at least 24×24px, except links sitting inside a sentence,
  which wcag exempts.
- tab order follows the document order. there are no positive `tabindex` values and no
  focus traps. focus is drawn as a 2px white outline, which is 21:1 against the page.
- form fields have real labels. sign-in and password-reset errors are announced through a
  live region rather than being written into a hidden element, and the fields are marked
  `aria-invalid` when a submission fails. errors are conveyed in words, not by colour.
- the animated diagram on the landing page has a pause button and stops entirely under
  `prefers-reduced-motion`.

## known limitations

these are real, and we would rather list them than let you find them.

1. **no screen reader pass.** we checked the accessibility tree the browser exposes to
   assistive technology, which is what a screen reader reads from, but we have not driven
   the site with voiceover, nvda, or jaws from start to finish. something can be correct
   in the tree and still be awkward to hear.
2. **no pass by a disabled user, and no third-party audit.** everything below was done by
   the person who wrote the site.
3. **one theme.** the site is dark only. there is no light theme, and we have not tested
   windows high contrast / `forced-colors` mode at all.
4. **code blocks have no name.** wide code samples scroll sideways and are keyboard
   focusable so you can scroll them with the arrow keys, but they announce as an unnamed
   region rather than "code sample, bash".
5. **the sign-in journey was tested as markup, not as a journey.** github sign-in cannot
   complete yet (see the [limitations page](/docs/limitations.html)), so the signed-in,
   terminal-bound, and invite-accepted screens were audited as the markup those states
   render, not by walking through them for real.
6. **automated testing finds a minority of problems.** `axe-core` detects perhaps a third
   to a half of wcag failures. zero violations means zero violations of the rules it can
   check, not zero problems.
7. **two pages were only checked structurally.** `/auth/reset.html` and `/auth/cli.html`
   build themselves from scripts that need live credentials to run at all, so they were
   checked for skip link, language, and title, and their form markup matches the sign-in
   form that was scanned, but they have not been through `axe-core` as rendered.
8. **we do not target level aaa**, and there is no plan to.

## tell us about a barrier

email **support@getcrosscode.dev**. say what page you were on, what you were trying to
do, and what you use: the browser, the screen reader, the magnification, whatever is
relevant. a description of what went wrong is enough; you do not need to know which wcag
criterion it was.

**what happens then:**

- we acknowledge within **5 working days**.
- if the barrier stops you installing crosscode or signing in, we aim to fix it or give
  you a working alternative within **30 days**, and tell you if that is going to slip.
- anything else goes on the list. we will tell you whether it is queued or declined, and
  why, rather than leaving you without an answer.

crosscode is a one-person project. that is not an excuse for a barrier, but it is
the reason the promise above is 5 days and 30 days rather than something faster.

## how this was assessed

- **last assessed:** 6 august 2026.
- **assessed by:** {{PROVIDER_NAME}}, self-assessment.
- **automated tool:** `axe-core` 4.13, run at tags `wcag2a`, `wcag2aa`, `wcag21a`,
  `wcag21aa`, `wcag22aa` and `best-practice`. run two ways: in a real chromium browser
  against every built page, and in the repository's test suite (`apps/docs-site/src/a11y.test.ts`)
  against every page and every state the sign-in, join, and device pages can render. the
  suite runs on every `pnpm test`, so a regression fails the build rather than waiting for
  the next audit.
- **manual checks:** contrast computed from the browser's own resolved colours against the
  composited background, for every text node on every page; reflow at a 320px viewport and
  at 200% zoom; target sizes measured from live layout; tab order and focus styling read
  from the dom and the stylesheet; the accessibility tree inspected on the sign-in, join,
  and device pages.
- **not done:** screen reader testing, `forced-colors` testing, and any testing with
  assistive technology other than the browser's own accessibility tree.

the next assessment is due whenever the site's markup changes materially, and the
regression suite runs in the meantime.

## before this takes effect

fill these in:

- `{{PROVIDER_NAME}}`: the legal name of the individual who publishes crosscode, used
  above under "assessed by".
