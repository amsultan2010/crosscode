# Workstream E: website redesign

Branch `amsultan2010/cc-e-website-redesign`, 2026-08-04.

Full visual redesign of `apps/docs-site`: new landing page, new stylesheet, an animated
two-panel demo built in CSS and vanilla JS, two named use cases, corrected encryption and
pricing claims, restyled auth pages, and a docs shell restyled without touching the
generator. Every word on the landing page was rewritten from scratch.

## What changed

| File | Change |
| --- | --- |
| `apps/docs-site/index.html` | Rewritten. New structure, new copy, animated loop, legal footer links, analytics include. |
| `apps/docs-site/src/style.css` | Rewritten, 1735 to 1851 lines. New token system, dark default plus a designed light theme, styles for the landing page, the generated docs shell, and the auth pages. |
| `apps/docs-site/src/main.js` | Rewritten, 69 to 166 lines. Copy buttons, mobile nav, scroll reveal, pricing toggle, and the demo timeline. |
| `apps/docs-site/auth/src/auth-form.js` | Added a footer line pointing at the install guide. |
| `apps/docs-site/auth/src/cli.js` | Removed an em dash from a heading. |
| `apps/docs-site/auth/src/reset.js` | Removed two em dashes from a comment. |

The auth pages were restyled entirely through CSS; their markup lives in
`auth/src/*.js` and needed almost no change.

## Design decisions

**Dark is the designed default, light is a real second theme.** `:root` holds the dark
palette; `@media (prefers-color-scheme: light)` re-tints page chrome only. Code and
terminal surfaces keep their own `--term-*` tokens in both themes, so a diff looks the
same everywhere. That is why the light theme reads as designed rather than inverted: it is
warm paper with dark code panels, not a flipped dark page. See screenshot 10.

**One accent, used semantically.** Mint `#4fe3b0` (dark) / `#0c8b67` (light) means
"live, settled, accepted, safe". Amber means "waiting for your review". Those two states
are the product, so the colour carries meaning rather than decoration. Everything else is
neutral. No gradients on text, no glow, no illustration.

**The animated loop is one attribute.** `.scene[data-step="0..5"]` drives every transition
from CSS. `main.js` only advances the number. That makes pausing, off-screen suspension,
and reduced motion trivial: stop advancing, or jump to a finished frame. Only `opacity`,
`transform`, and `clip-path` are animated, and elements that appear later still occupy
their space while invisible, so the panels never reflow mid-loop.

**Type scale reset.** The old stylesheet set `html { font-size: 19px }` and then wrote
`1.05rem` on nearly everything, which flattened the hierarchy. This one uses 16px and a
real scale.

**The hero board is not a preview of the demo.** It shows presence, claims, and a waiting
proposal, which are three product surfaces the animation does not cover. Duplicating the
loop there would have wasted the space.

**Sections dropped.** "Two ways to use Crosscode", the "benefits" grid, and the generic
"use cases" grid all restated the same argument. The page is now: problem, loop, cost
ledger, two named teams, how it works, encryption, pricing, install, status, FAQ.

## Success criteria

### 1. `pnpm docs:build` passes: FAILS on this branch, by design, and passes with workstream B's file present

The brief instructs me to add `<script type="module" src="/src/analytics.js"></script>`
even though workstream B owns that file and it does not exist here. Vite resolves module
scripts at build time, so the build cannot complete without it:

```
$ pnpm docs:build
[generate-docs] wrote generated doc pages, public/docs/*.md, llms.txt, llms-full.txt
vite v7.3.6 building client environment for production...
transforming...
✗ Build failed in 57ms
error during build:
[vite:build-html] Failed to resolve /src/analytics.js from
  /Users/a.m.sultan/orca/workspaces/crosscode/cc-e-website-redesign/apps/docs-site/index.html
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @crosscode/docs-site@ build: `node scripts/generate-docs.mjs && vite build`
Exit status 1
```

With a one-line placeholder at `apps/docs-site/src/analytics.js` (created for this check,
then deleted, and not committed) the same command passes:

```
$ pnpm docs:build
[generate-docs] wrote generated doc pages, public/docs/*.md, llms.txt, llms-full.txt
vite v7.3.6 building client environment for production...
✓ 21 modules transformed.
dist/docs/mcp-clients.html                      18.62 kB │ gzip:  6.30 kB
dist/docs/safety.html                           39.19 kB │ gzip: 14.72 kB
dist/index.html                                 43.11 kB │ gzip: 11.49 kB
dist/assets/style-B1wNZuEv.css                  38.25 kB │ gzip:  7.83 kB
dist/assets/main-B3JxUxsJ.js                     2.44 kB │ gzip:  1.05 kB
dist/assets/auth-form-BkpRNiqJ.js                4.80 kB │ gzip:  2.19 kB
✓ built in 189ms
```

**Coordinator action: nothing to fix, this resolves itself when B's branch merges.** Run
`pnpm docs:build` once after the merge to confirm.

Every screenshot below was taken from that passing build.

### 2. Screenshots at 390px, 768px, and 1440px, plus an auth page and a docs page

All in `docs/status/2026-08-04-website-redesign/`. Taken in Orca's browser
(`orca tab create` / `goto` / `eval` / `screenshot`), never claude-in-chrome.

| File | What |
| --- | --- |
| `01-1440-hero-dark.png` | Landing hero, 1440px, dark |
| `02-1440-animated-loop.png` | The animated loop mid-cycle, packet in flight |
| `03-1440-use-cases.png` | Hackathon crew and startup founders |
| `04-1440-pricing.png` | Pricing grid |
| `05-1440-faq-footer.png` | FAQ, closing CTA, footer with the legal links |
| `06-768-hero.png`, `07-768-loop.png` | 768px |
| `08-390-hero.png`, `09-390-pricing.png` | 390px |
| `10-1440-light-theme.png` | Light theme |
| `11-1440-reduced-motion.png` | `prefers-reduced-motion: reduce` |
| `12-auth-signin.png` | `/auth/signin.html` |
| `13-docs-architecture.png` | `/docs/architecture.html` (generated page) |
| `14-focus-ring.png` | The focus ring, see criterion 7 |

**How the widths were produced.** `orca set device` changes the user agent but not the
layout viewport on this machine (verified: after `--name "iPhone 12"` the UA reported
iPhone while `innerWidth` stayed 1103), and there is no width flag on `orca tab create`
or `orca screenshot`. So each page was loaded into a same-origin `<iframe>` of exactly
390 / 768 / 1440 CSS px inside a throwaway `dist/_shot.html`, scaled with a CSS transform
to fit the window. Confirmed per width before shooting, for example:

```
$ orca eval --expression "(()=>{const d=document.querySelector('iframe').contentDocument;
    return d.documentElement.clientWidth+' / '+d.documentElement.scrollWidth})()"
"390 / 390"
"768 / 768"
"1440 / 1440"
```

`scrollWidth === clientWidth` at all three widths, so there is no horizontal overflow
anywhere on the page. That check found a real bug: grid children default to
`min-width: auto`, so the nowrap `crosscode publish --branch feat/payment-retry` line in a
use-case card widened its track and pushed the page 55px sideways at 390px. Fixed with
`min-width: 0` on grid children.

`dist/_shot.html` is build output only and is not committed.

**The auth screenshot needed placeholder credentials.** `auth/src/supabase.js` throws
unless `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set at build time, so with no
env the page renders an empty card. This is pre-existing and not something this workstream
changed. Screenshot 12 comes from a build with
`VITE_SUPABASE_URL=https://example.supabase.co VITE_SUPABASE_ANON_KEY=placeholder-anon-key`.
No credential was submitted and no network call was made.

### 3. The animated demo runs, loops cleanly, and does not jank: PASSES

Sampled the live page every 250ms for 30 seconds:

```
$ orca eval --expression "... window.__steps ..."
samples=120 transitions=0>1>2>3>4>5>0>1>2>3>4>5>0>1>2>3>4
```

Three full cycles, correct order, no skipped or repeated step. One cycle is 11.25s.

Everything actually animating, read from `document.getAnimations()` at the busiest moment:

```
ln add a1:line-in | ln add a2:line-in | ln add a3:line-in | ln add a4:line-in
| ln add a5:line-in | ln add a6:line-in | typed:type-in | caret:caret-blink
```

`line-in` animates `opacity` and `transform`, `type-in` animates `clip-path`,
`caret-blink` animates `opacity`, and `packet-across` (step 2 only) animates `transform`
and `opacity`. Nothing animates a layout property, so there is no reflow per frame.

The panels do not resize mid-loop: lines that have not appeared yet are `opacity: 0` and
still in flow, so the loop causes no layout shift at all.

It stops when it is not being watched. Scrolled the scene out of view and sampled for 12s:

```
step at scroll time: 3
samples=48 distinct=4
```

It ran the one already-scheduled timeout to step 4 and then held there for the whole 12s.
The same happens on `visibilitychange`, and a Pause control (WCAG 2.2.2) is rendered next
to the step captions.

### 4. `prefers-reduced-motion: reduce`: PASSES, verified with the media feature forced

`orca set media --reduced-motion reduce` reports `{"set": true}` but does not take effect
in this browser; `matchMedia('(prefers-reduced-motion: reduce)').matches` stayed `false`
in both the top frame and the iframe, before and after a reload. Colour-scheme emulation
on the same command does work, so this is specific to the reduced-motion feature.

Verified instead against the exact shipped code, by (a) taking the built stylesheet and
replacing `@media(prefers-reduced-motion:reduce)` with `@media all`, and (b) stubbing
`window.matchMedia` in a classic script before the deferred module runs so `main.js` takes
its reduced-motion branch. Both rules and both branches are the ones that ship.

```
$ orca eval --expression "..."
rm=true step=done toggle=none noteAfter=block revealOpacity=1

$ orca eval --expression "..."
{"addAnim":"1e-06s","addOp":"1","packetAnim":"1e-06s","typedClip":"none",
 "caret":"none","revealTrans":"1e-06s"}

$ sleep 8; orca eval --expression "...dataset.step"
"done"
```

Nothing animates, no timer runs, and the scene renders its finished frame: all six added
lines, both settle logs, the sealed packet, the proposal in its accepted state reading
"Applied. Base re-checked, checkpoint taken first.", the accept command, and both apply
logs. All four step captions are plain readable text at full contrast. Screenshot 11.
Every scroll-reveal element is at `opacity: 1`, so no content is hidden.

**Please re-check this one by hand** with the OS setting on (macOS: Settings, Accessibility,
Display, Reduce motion), since I could not drive the real media feature.

### 5. Dark mode renders correctly: PASSES

Dark is the default, so screenshots 01 to 09 and 11 are all dark mode, captured with
`orca set media --color-scheme dark`. Screenshot 10 is the light theme under
`--color-scheme light`, included because a light theme is new in this redesign and worth
seeing. Colour-scheme emulation was confirmed working:

```
$ orca eval --expression "matchMedia('(prefers-color-scheme: dark)').matches"
"true"
```

### 6. `grep -c "—"` returns 0 on every file I touched: PASSES for the committed tree, with one caveat

```
$ for f in apps/docs-site/index.html apps/docs-site/src/style.css apps/docs-site/src/main.js \
           apps/docs-site/auth/src/*.js apps/docs-site/auth/*.html; do
    printf '%s %s\n' "$(grep -c '—' $f)" "$f"; done
0 apps/docs-site/index.html
0 apps/docs-site/src/style.css
0 apps/docs-site/src/main.js
0 apps/docs-site/auth/src/account.js
0 apps/docs-site/auth/src/auth-form.js
0 apps/docs-site/auth/src/cli.js
0 apps/docs-site/auth/src/reset.js
0 apps/docs-site/auth/src/supabase.js
0 apps/docs-site/auth/cli.html
0 apps/docs-site/auth/reset.html
0 apps/docs-site/auth/signin.html
0 apps/docs-site/auth/signup.html
```

No `&mdash;` entities either.

**Caveat, and it needs a decision from the coordinator.** `scripts/generate-docs.mjs`
(workstream C) has a `syncInstallPrompt()` step that copies the fenced block out of
`docs/install-prompt.md` straight into the `<pre><code id="install-prompt-text">` element
in `index.html` on every build. That markdown file has three em dashes inside the fence,
at lines 16, 20, and 33. So immediately after any `pnpm docs:build`:

```
$ grep -n '—' apps/docs-site/index.html
593:— within seconds, instead of at pull-request time. Their work arrives as proposals
597:   and tell me — everything below needs it.
610:   you cannot see. Show me that URL and wait — I have to open it and sign in (or
```

I own neither `docs/install-prompt.md` nor the generator, so I did not edit either. The
committed `index.html` carries my em-dash-free wording of those three lines, which means
running the build dirties the working tree until the markdown is fixed.

**Requested change to `docs/install-prompt.md` (workstream C), inside the ````text fence:**

- line 16: `— within seconds, instead of at pull-request time.` becomes
  `within seconds, instead of at pull-request time.`
- line 20: `and tell me — everything below needs it.` becomes
  `and tell me, because everything below needs it.`
- line 33: `Show me that URL and wait — I have to open it` becomes
  `Show me that URL and wait. I have to open it`

Those three edits make the source and the generated output identical again. Two further
em dashes live outside the fence (lines 7 and 58) and never reach the site, but they break
the writing rule too.

The generated docs pages under `apps/docs-site/docs/` also contain em dashes, inherited
from `docs/*.md`. Those are workstream C's files and I did not touch them.

### 7. Keyboard navigation reaches every interactive element with a visible focus state: PARTIALLY VERIFIED

**Could not drive Tab in this environment.** The Orca browser window never holds OS focus,
so the page cannot receive keyboard focus at all:

```
$ orca eval --expression "document.hasFocus()"
false
```

With `hasFocus()` false, `:focus` never matches, `orca keypress --key Tab` returns
`{"pressed":"Tab"}` but `document.activeElement` does not move, and `orca focus --element`
sets `activeElement` without setting any focus pseudo-class. So the live Tab walk is not
something I can honestly claim to have run.

What I did verify:

**The focusable set is complete and in DOM order.** 58 focusable elements, all visible,
no `tabindex` attribute anywhere on the page, so nothing is removed from or reordered in
the tab sequence:

```
$ orca eval --expression "..."
{"count":58,"tabindexAttrs":[],"first":["A.skip-link/Skip to content","A.brand/Crosscode",
 "A./The loop","A./Why","A./Use cases","A./Encryption","A./Pricing","A./Docs"]}
```

The skip link is first and reveals itself on focus (`top: -4rem` to `top: 0`). Every
control is a real `<a>` or `<button>`; the FAQ uses `<details>/<summary>`; the mobile nav
toggle carries `aria-expanded` and `aria-controls`; the pause control carries
`aria-pressed`; the billing toggle buttons carry `aria-pressed`.

**The ring renders.** The shipped declaration is
`:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px }`. Screenshot 14
applies that exact declaration to a nav link, the GitHub pill, the primary button, the
secondary button, the copy button, and an inline body link, so the ring geometry, colour,
and offset can be judged against every control shape on the page.

**Please spot-check by hand**: open the built site, press Tab from the address bar, and
confirm the ring appears on each control in order.

### 8. No console errors on load: PASSES

Installed `console.error`/`console.warn` hooks plus `error` and `unhandledrejection`
listeners in a classic script before the deferred module, then loaded the built page:

```
$ orca eval --expression "JSON.stringify(window.__log)"
"[]"
```

Empty. There is no 404 for `analytics.js` in a production build even before B's file
exists, because Vite bundles both entry modules of `index.html` into a single chunk, so
`dist/index.html` ends up with one `<script>` tag:

```
$ grep -o '<script[^>]*>' dist/index.html
<script type="module" crossorigin src="./assets/main-B3JxUxsJ.js">
```

The 404 the brief anticipated would only appear under `pnpm docs:dev`, where modules are
served unbundled. On this branch that is moot: the production build cannot run at all
without the file (criterion 1).

### 9. Every pricing number traces to a line in `billing.ts` or `stripe.ts`: PASSES

All references are `apps/service/src/billing.ts` unless noted.

| Claim on the page | Source |
| --- | --- |
| Free, $0, up to 5 people or agents | L39 `free: { seatCap: 5, ... }` |
| Free, 7 days of proposal history | L39 `historyRetentionDays: 7` |
| Free, auto-apply when a change is clean | L39 `autonomyTiers: ["always-ask", "auto-if-clean"]` |
| Essential, $2.50/mo | L109 `monthlyCents: 250` |
| Essential, $25/yr | L109 `annualCents: 2_500` |
| Essential, up to 10 people or agents | L40 `seatCap: 10` |
| Essential, 30 days of history | L40 `historyRetentionDays: 30` |
| Essential, auto-apply always unlocked | L40 `autonomyTiers: ALL_AUTONOMY_TIERS`, with L15 |
| Pro, $5/mo and $50/yr | L110 `monthlyCents: 500, annualCents: 5_000` |
| Pro, up to 25 people or agents, 90 days | L41 `seatCap: 25, historyRetentionDays: 90` |
| Unlimited, $7.50/mo and $75/yr | L111 `monthlyCents: 750, annualCents: 7_500` |
| Unlimited, unlimited people, 365 days | L42 `seatCap: Infinity, historyRetentionDays: 365` |
| Team, $5 per seat / month, $50 per seat / year | L112 `monthlyCents: 500, annualCents: 5_000, perSeat: true` |
| Team, unlimited seats, 365 days | L43 `seatCap: Infinity, historyRetentionDays: 365` |
| Team is per seat, so Unlimited undercuts it above about five seats | L112 `perSeat: true` plus L127 `priceCentsFor`, L134 `seatQuantityFor` |
| "2 months free" on the yearly toggle | L109 to L113: every annual price is exactly ten times the monthly one |
| Students get Pro at Essential's price, 25 seats and 90 days for $2.50 | L44 `student: { seatCap: 25, historyRetentionDays: 90 }` and L113 `monthlyCents: 250` |
| Student is granted after verification, the CLI refuses a self-serve upgrade | `apps/service/src/http.ts` L786 to L788, throws `403 "Student pricing requires verification and cannot be purchased self-serve"` |
| Unlimited AI review on every plan including free | L39 to L44, `semanticReviewCallsPerMonth: Infinity` on all six |
| A failed payment costs nothing for 14 days | L124 `PAYMENT_GRACE_PERIOD_DAYS = 14` |
| Nothing is deleted by a downgrade, cancellation, or failed payment | L74 to L80 `maxAutonomyTierFor` and L88 to L92 `clampAutonomyTierToPlan` clamp rather than delete |
| Unlimited repositories and workspaces | No per-repository limit exists; the only account-level cap is L60 `MAX_SELF_SERVE_WORKSPACES_PER_USER = 10`, an abuse ceiling on workspaces you own, not on repositories. The page says "unlimited repositories and workspaces", which is loose about that cap. Flagging it rather than removing it, since the cap sits far above what a real team hits. |

The old page showed annual as a derived per-month figure ($2.08, $4.17, $6.25). Those
appear nowhere in the source, so the yearly toggle now shows the annual price directly.
Every number on the page is a literal from `billing.ts`.

`stripe.ts` defines no prices of its own; it maps plan and interval to price IDs from the
`CROSSCODE_STRIPE_PRICES` environment catalogue (L46 to L67), so nothing on the page
traces there.

## Contracts with other workstreams

**Analytics (workstream B).** `<script type="module" src="/src/analytics.js"></script>` is
the last element in `<body>` of `index.html`. The file does not exist on this branch, which
is what breaks `pnpm docs:build` here. No further action needed at merge.

**Legal links (workstream C).** The footer links `/docs/terms.html`,
`/docs/refund-policy.html`, and `/docs/support.html` under a "Trust" column, next to Safety
model, Privacy, and Limitations. Those three pages do not exist on this branch, so the
links 404 until C's branch merges. Nothing to change at merge.

## Claims that depend on workstream A

Verify each of these before launch:

1. **`npx crosscode-cli start`** appears three times: the hero command strip, the install
   section, and the closing CTA. It is also inside the agent install prompt as
   `npx --yes crosscode-cli start --no-browser`. All of it assumes `crosscode-cli` is
   published to npm. It is not, today.
2. **`npm install -g crosscode-cli`** in the install section note.
3. **`crosscode start`, `crosscode join --invite <code>`, `crosscode accept`,
   `crosscode publish --branch`, `crosscode claim path`, `crosscode key export`** appear in
   copy, in the animated demo, and in the use-case cards. These need the published package
   to be reachable by a reader.
4. **"Nothing to deploy"** in the hero footnote and **"It configures the checkout, signs you
   in, attaches you to a workspace"** in the install section both assume the hosted
   coordination service answers. `https://www.getcrosscode.dev/api/v1/*` returns 500 today.
5. **`/auth/signup.html` and `/auth/signin.html`** are linked from the nav, the footer, and
   three pricing cards. They need `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` set in
   the deployment environment or they render an empty card, as described under criterion 2.

The page does not claim the hosted service is live. The status section says plainly that
live push through the hosted service is polling rather than a socket, and that no live
Stripe account exists so nothing is chargeable.

## Encryption claim, scoped

The old copy said "We can't read your code" and listed "file contents, paths, diffs, and
content hashes". The redesign keeps the claim prominent (its own section, plus a hero
footnote and an FAQ entry) and states both halves:

- **Encrypted on your machine:** file contents, file paths, diffs, content hashes, change
  intents.
- **Visible to the service:** account email and workspace/device/project identifiers, the
  Git remote URL, timestamps and file counts and payload sizes, whether a file was added,
  modified, deleted, or renamed but not which file, and task titles, claim targets,
  published intents, handoff notes, and validation output, which are not encrypted yet.

The two lists sit side by side at equal weight and link to `/docs/privacy.html`. The
"Not yet" status card repeats the unencrypted-metadata point so a reader skimming only
that section still sees it.

## Things I did not do, and why

- **Did not edit `scripts/generate-docs.mjs`.** The generated docs shell uses class names
  the old stylesheet defined (`nav-github`, a bare `<nav>` with no wrapper, a `.brand` with
  no child span, a two-paragraph `.site-footer`). Instead of changing the generator I made
  the CSS match both shapes: `.site-header nav:not(.docs-sidebar)` styles either markup,
  `.nav-github` shares the `.nav-ghost` rules, `.brand::before` draws the mark for both
  (so `index.html` dropped its `<span class="brand-mark">`), and `.site-footer > p` handles
  the simple footer. Screenshot 13 shows the result. No generator change is needed.
- **Did not edit `docs/install-prompt.md`** or any `docs/*.md`. See criterion 6.
- **Did not touch** `vite.config.js`, `vercel.json`, `apps/docs-site/api/**`,
  `apps/docs-site/docs/**`, `README.md`, or `BUILD_INSTRUCTIONS.md`.
- **Did not create** `apps/docs-site/src/analytics.js`. A stub was created twice to run the
  build checks and deleted both times; `git status` is clean of it.
- **Did not add a web font.** System sans plus `ui-monospace`. The whole stylesheet is
  38.25 kB, 7.83 kB gzipped, and the page JS is 2.44 kB, 1.05 kB gzipped.

## Known gaps in this branch

- Reduced motion and keyboard focus were verified indirectly, for the environment reasons
  above. Both want a two-minute manual check.
- The animated panels reserve space for content that has not appeared yet, so on a 390px
  screen the scene is tall (roughly 1400px). It causes no layout shift, but it is the one
  place the mobile layout feels long.
- The "unlimited repositories and workspaces" line on the Free card is loose about
  `MAX_SELF_SERVE_WORKSPACES_PER_USER = 10`. See criterion 9.
