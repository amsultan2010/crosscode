# Workstream D: documentation truth-up and de-slop (2026-08-04)

Branch `amsultan2010/cc-d-docs-deslop`. Two jobs in one pass: correct the docs where they
contradict what shipped in #38 (Stripe), #39 (`crosscode start`, npm packaging), and #40
(end-to-end encryption), then remove the em dashes and the rest of the machine-written
texture from every file this workstream owns.

## Verification, with real output

### 1. Zero em dashes across owned files

```
$ grep -rn $'\u2014' README.md BUILD_INSTRUCTIONS.md AGENTS.md CONTRIBUTING.md SECURITY.md \
    CODE_OF_CONDUCT.md docs/ .github/ISSUE_TEMPLATE/ \
    packages/core/src packages/git/src packages/protocol/src packages/test-fixtures/src \
    apps/cli/src apps/daemon/src apps/mcp-server/src
$ echo $?
1
```

No output, exit 1 (grep found nothing). The `$'\u2014'` spelling is there because this status
file sits inside `docs/`, which is one of the paths being searched, so it cannot hold a
literal em dash to paste.

Starting count was 320 matching lines across 15 files: README 37, BUILD_INSTRUCTIONS 93, security.md 42, mcp-clients.md 27, status snapshot
22, onboarding-contracts 21, architecture 11, protocol 17, privacy 9, AGENTS 14,
CONTRIBUTING 14, install-prompt 5, SECURITY 2, two issue templates 2 each. Plus 24 in source
comments and strings under `apps/mcp-server/src`, `apps/cli/src`.

Every one was rewritten at the sentence level. `CODE_OF_CONDUCT.md` had none and is
untouched.

One of those was structural rather than prose: `apps/mcp-server/src/generate-tool-docs.ts`
joined each tool name to its description with an em dash, so the generated catalog in
`docs/mcp-clients.md` would have reintroduced 20 of them on the next regeneration. The
separator is now a colon and the catalog was regenerated with
`pnpm --filter @crosscode/mcp-server generate:docs`.

### 2. `pnpm docs:build`

```
$ pnpm docs:build
...
dist/docs/mcp-clients.html   19.36 kB │ gzip: 6.55 kB
dist/index.html              38.62 kB │ gzip: 10.70 kB
dist/docs/safety.html        39.45 kB │ gzip: 14.77 kB
✓ built in 598ms
```

Passes.

**The limitations criterion cannot be met from this workstream, and the brief's premise
about it is wrong.** `apps/docs-site/docs/limitations.html` is not generated from the README.
`apps/docs-site/scripts/generate-docs.mjs` generates `architecture.html`, `safety.html`,
`privacy.html`, `protocol.html`, and `mcp-clients.html` from the root `docs/*.md` (they are
listed in `apps/docs-site/.gitignore` for exactly that reason). `limitations.html`,
`install.html`, `cli.html`, and `index.html` are hand-written and tracked. `limitations.html`
was unchanged by my build:

```
$ git show HEAD:apps/docs-site/docs/limitations.html | md5
001e129f764de27fd915d6d9270edf69
$ md5 -q apps/docs-site/docs/limitations.html
001e129f764de27fd915d6d9270edf69
```

It is under `apps/docs-site/**`, which this workstream is scoped out of. It is still stale
and still contains an em dash: the sentence beginning "not published to npm or any editor
marketplace" still describes the supported surface as "the daemon + MCP server, run from a
cloned checkout", which stopped being the install story when #39 landed npm packaging.

**For workstream E or the coordinator:** `apps/docs-site/docs/limitations.html` needs to be
rewritten by hand against the new `README.md` § Current limitations. Either that, or add it
to `GENERATED_PAGES` so it stops drifting.

**Second thing E needs to know:** `pnpm docs:build` also rewrites the
`<pre><code id="install-prompt-text">` block in `apps/docs-site/index.html` from
`docs/install-prompt.md`, which I do own and did change. The build therefore left
`apps/docs-site/index.html` modified. I reverted it (`git checkout --`) rather than commit a
file E owns. Running `pnpm docs:build` after this branch merges will resync it.

### 3. `pnpm test`

```
$ pnpm test
 Test Files  34 passed | 9 skipped (43)
      Tests  390 passed | 42 skipped (432)
```

Passes. Nothing asserted on the strings I edited.

Baseline note for honesty: the run I took *before* touching anything failed one test,
`apps/cli/src/start.test.ts > takes a paired checkout from nothing to a running daemon`, with
`ENOTEMPTY: directory not empty, rmdir '/private/var/.../crosscode-start-TVgLN8/.git/objects'`.
That is a temp-directory cleanup race, unrelated to docs, and it did not recur on either run
afterwards. Flagging it because it will resurface.

`pnpm build` also passes (`tsc --noEmit` plus the three esbuild bundles).

### 6. The README is shorter

```
$ git show 8e4089a:README.md | wc -lwc
     505    5354   37557
$ wc -lwc README.md
     496    5351   37470
```

Shorter on all three counts, but only barely, and that is worth being straight about: the
limitations section grew because two real facts had to be added (unpublished package, 500ing
API) and the encryption claim had to be qualified in three places. The cuts that paid for
that were the `service:provision` Alice/Bob walkthrough (compressed from ~30 lines to one
block), the triplicated `SUPABASE_ANON_KEY` self-hosting explanation (now stated once and
cross-referenced), a 13-item "the current suite covers…" list that carried no information,
and the npm bin-resolution paragraph.

## 4. Claims checked, and what each check returned

| Claim as it stood | How I checked it | Verdict |
| --- | --- | --- |
| `README.md:490` "There is no hosted/managed coordination service yet" | `apps/daemon/src/hosted.ts:19` sets `DEFAULT_SERVICE_URL = "https://www.getcrosscode.dev"`; `curl -o /dev/null -w "%{http_code}" https://www.getcrosscode.dev/` → `200` | **False.** Replaced with what is actually true: the service is the compiled-in default and its API is currently broken |
| `README.md:491` "There is no production website deployed yet, so `crosscode login` has no default site" | `curl` on `/` → 200, `/auth/cli.html` → 200, `/auth/signup.html` → 200; `resolveWebUrl()` in `apps/daemon/src/browser-login.ts` falls back to `DEFAULT_WEB_URL` and its own comment says `WEB_URL_REQUIRED` is no longer reachable | **False.** Removed; the deprecated-`CROSSCODE_DASHBOARD_URL` note that was buried in it was kept |
| "Billing is a placeholder, no payment provider wired up" | `apps/service/src/stripe.ts` is 353 lines of `StripeBillingProvider`; `apps/service/src/http.ts:334` routes `POST /v1/webhooks/stripe`; BUILD_INSTRUCTIONS Phase 10 | **Stale.** Stripe is implemented. What is *not* done is the live account and price ids, which the bullet now says |
| "The CLI is deliberately not published to npm" (design choice) | `npm view crosscode-cli version` → `E404 ... could not be found`; BUILD_INSTRUCTIONS "Distribution and hosting" says the npm token is expired and `npm login` needs a TTY | **Wrong framing.** Unpublished for an operational reason, not by design. Bullet rewritten and a status callout added at the top of the README |
| "checkout answers 503 and the webhook route does not exist" without Stripe config | `apps/service/src/http.ts:903` throws `HttpError(503, "Billing is not configured on this deployment")`; the webhook handler at :334 requires `options.billing?.webhookSecret` | **True.** Kept verbatim in meaning |
| "`crosscode billing upgrade --plan student` is refused" | `apps/service/src/http.test.ts:1261` posts `{plan:"student"}` and asserts the refusal; BUILD_INSTRUCTIONS Phase 10 states the 403 | **True.** Kept |
| README "The service must run as a persistent process, **not** on serverless functions" | `apps/docs-site/api/[...path].ts` and `apps/service/src/serverless.ts` both exist; the README's own Packaging section says `apps/service` "runs as functions inside the website's deployment" | **Self-contradictory.** Rewritten: a persistent process is what gets you the `/v1/stream` WebSocket, the hosted deployment runs on Vercel functions and therefore polls |
| `docs/security.md` "`api.getcrosscode.dev` stores ciphertext" | The comment in `apps/daemon/src/hosted.ts` records that the `api.` subdomain "was never created"; `curl` confirms only `www.` resolves | **False host.** Corrected to `www.getcrosscode.dev` |
| `docs/architecture.md` + `docs/onboarding-contracts.md` "no production default … fails with `WEB_URL_REQUIRED`" | `resolveWebUrl()` in `apps/daemon/src/browser-login.ts`; `grep -rn WEB_URL_REQUIRED` finds only the comment saying it no longer throws | **False.** Both corrected |
| `.github/ISSUE_TEMPLATE/*` offering `apps/vscode-extension` | `ls apps/` → `cli daemon docs-site mcp-server service` | **Gone.** Removed from both templates |
| `SECURITY.md` scope: "does not currently run a hosted/managed coordination service" | Same checks as row 1 | **False.** Scope now names the hosted deployment and says reports against it are in scope |
| "File payloads are end-to-end encrypted … so a hosted service stores code it cannot read" | `packages/protocol/src/index.ts:92-131` (`sealedEnvelopeSchema`, `sealedTransactionSchema`) vs `:7-18` (`taskSchema`, `claimSchema`), `:769` (`handoffSchema.note`), `:830` (`intentSchema.text`) | **Overstated.** See below |
| BUILD_INSTRUCTIONS says nothing at all about encryption | `grep -in "encrypt" BUILD_INSTRUCTIONS.md` → only an unrelated `e2e` test filename | **Missing.** Added a status entry and a non-goal |

## 5. The encryption wording, quoted, and what E should match

The gap is real and confirmed in the schemas. `sealedTransactionSchema` carries an opaque
AEAD blob plus one `pathToken` per file, and everything content-bearing is inside it. But
`taskSchema` has plaintext `title`, `intent`, and `paths`; `claimSchema` has a plaintext
`target`; `handoffSchema` has a plaintext `note`; `intentSchema` has plaintext `text`; and
validation results carry their output. All of those are stored and relayed in the clear.

Per the user's decision, the claim is tightened now and the gap closes later. Wording is
consistent across `README.md`, `docs/privacy.md`, `docs/security.md`, `docs/protocol.md`,
`docs/architecture.md`, and `BUILD_INSTRUCTIONS.md`. The canonical two sentences, from
`README.md` § What works today:

> **File payloads are end-to-end encrypted by default.** File contents, paths, diffs,
> content hashes, and the change intent attached to a transaction are sealed on your machine
> under a workspace key the coordination service never receives. Coordination metadata
> outside the file payload is not sealed: task titles, claim targets, published intents,
> handoff notes, and validation output reach the service in the clear, and they can carry
> paths.

Safety-model rule 5, whose heading used to be the flat "The coordination service cannot read
your code":

> **The coordination service cannot read your file payloads.** Contents, paths, diffs,
> hashes, and change intents are encrypted before they leave your machine, and a receiving
> checkout verifies them against a key the service has never held rather than trusting what
> the service asserts about them. Task titles, claim targets, published intents, handoff
> notes, and validation output travel in the clear, so the service can read those.

`docs/privacy.md` keeps "**We can't read your code.**" as its lead, because that sentence is
true of code specifically, but the qualifier now sits in the same opening block instead of
40 lines down:

> That covers the file payload and nothing else. Coordination metadata still reaches us in
> the clear: task titles, claim targets, published intents, handoff notes, and validation
> output. Those can contain file paths and descriptions of what you are working on.

**Workstream E:** the landing page is yours, not mine, and I did not touch it. Match the
list exactly, in this order, because it is now the same five items in six files: *task
titles, claim targets, published intents, handoff notes, and validation output*. The
short form for a marketing context is "your code is encrypted; the labels on it are not."
Do not let any landing-page copy say or imply "we can't see anything".

## Things I could not do, and why

- **`apps/docs-site/docs/limitations.html` is still stale and still has an em dash.** Out of
  scope for this workstream, and it is not README-generated the way the brief assumed. Detail
  under criterion 2 above.
- **`apps/service` and `apps/docs-site` still contain em dashes**, as expected. Nine files
  outside `dist/`, for the coordinator to finish:
  `apps/service/src/http.ts`, `apps/service/src/http.test.ts`,
  `apps/docs-site/index.html`, `apps/docs-site/docs/limitations.html`,
  `apps/docs-site/auth/src/cli.js`, `apps/docs-site/auth/src/reset.js`,
  `apps/docs-site/scripts/generate-docs.mjs`, `apps/docs-site/public/llms-full.txt`
  (generated), `apps/docs-site/.gitignore` (a comment).
- **Nothing was verified against a working hosted API,** because there isn't one.
  `https://www.getcrosscode.dev/api/v1/health` returns:

  ```
  A server error has occurred
  FUNCTION_INVOCATION_FAILED
  cle1::lcj74-1785880000858-c59d49b035ed
  HTTP 500
  ```

  Once workstream A lands its fix, the sentence to delete is the second bullet of the status
  callout at the top of `README.md`, and the second bullet of § Current limitations. Nothing
  else in the docs assumes the API is broken.
- **Nothing was verified against a published package.** After `npm publish` lands, delete the
  first bullet of the README status callout, the first bullet of § Current limitations, the
  "This needs the npm package" sentence under § Fastest way to try it with an agent, the
  two-paragraph note in `docs/install-prompt.md`, and the note under "The short version" in
  `docs/mcp-clients.md`. Every install command in those files is already written for the
  published package and needs no edit. Command to confirm:

  ```
  npm view crosscode-cli version
  ```

  Today that returns `E404 ... 'crosscode-cli@*' could not be found`.

## What was left conditional

Nothing is written as "will work once X". Every statement describes the state on 2026-08-04
and is bracketed so that a single deletion makes it current again after A lands. The two
deletion lists are directly above.

## Files changed

`README.md`, `BUILD_INSTRUCTIONS.md`, `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`,
`docs/architecture.md`, `docs/privacy.md`, `docs/protocol.md`, `docs/security.md`,
`docs/mcp-clients.md`, `docs/install-prompt.md`, `docs/onboarding-contracts.md`,
`docs/status/2026-08-02-cli-only-pass.md`, `.github/ISSUE_TEMPLATE/bug_report.md`,
`.github/ISSUE_TEMPLATE/feature_request.md`, `apps/cli/src/index.ts`,
`apps/mcp-server/src/resources.ts`, `apps/mcp-server/src/tool-catalog.ts`,
`apps/mcp-server/src/generate-tool-docs.ts`.

`CODE_OF_CONDUCT.md` needed no change.

The 2026-08-02 status snapshot was left as a snapshot: its historical claims stand, and three
that have since been overtaken carry dated **Correction (2026-08-04)** notes in the style the
file already used, rather than being rewritten.
