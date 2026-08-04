# Workstream A: production unblock

Branch `amsultan2010/cc-a-production-unblock`, 2026-08-04.

## What you have to do yourself

Two things block a stranger running one command, and neither can be finished from a branch.

1. **The Vercel project has no `DATABASE_URL` and no `SUPABASE_URL`, in any environment.**
   This is a second, independent cause of the 500s, and I found it only by deploying. The
   import fix in this branch is necessary and not sufficient: with it, `/api/health` returns
   200 and every database-backed route still returns 500 until those variables exist. See
   [Set the service environment variables](#set-the-service-environment-variables) for the
   exact commands.
2. **`@crosscode/cli` is still unpublished.** Publishing needs an interactive `npm login` and
   an npm account that owns the `@crosscode` scope. Everything up to `npm publish` is done and
   verified; the ordered commands are in
   `docs/status/2026-08-04-npm-publish-checklist.md`.

## Problem 1: the hosted service returned 500 on every route

Reproduced before touching anything:

```
$ curl -s -o /dev/null -w "%{http_code}\n" https://www.getcrosscode.dev/api/health
500
$ curl -s -o /dev/null -w "%{http_code}\n" https://www.getcrosscode.dev/v1/memberships
500
```

### The cause, and a second one behind it

`apps/docs-site/api/[...path].ts` imports `@crosscode/service/serverless`. That package's
`exports` pointed at `./src/serverless.ts`. Vercel traced the import, copied the TypeScript
file into the function, and Node refused to load it from `node_modules`. Every workspace
package in this repository does the same thing (`@crosscode/core`, `@crosscode/protocol` and
the rest all export `./src/index.ts`), so the problem is not one manifest: it is the whole
dependency graph reachable from that import.

### Approach, and why

I bundled the function's entry rather than emitting per-package JavaScript. The alternative
means giving `@crosscode/service`, `@crosscode/core` and `@crosscode/protocol` each a tsc
build, a `dist/`, and an `exports` map pointing at it, then arranging for Vercel to run all
three builds before it traces the function, and then keeping `tsc --noEmit`, vitest and tsx
working against packages whose public entry no longer exists until something has been built.
That is four moving parts to fix one import. `scripts/build.mjs` already answers the same
question the same way for the published CLI, and its reasoning holds here: these nine
packages have no external consumers, so a bundle costs nothing and removes every resolution
step that would otherwise have to hold at runtime on a platform I cannot debug from here.

`scripts/build-serverless.mjs` bundles `apps/service/src/serverless.ts` into one
self-contained `apps/service/dist/serverless.js` (618 kB), and
`exports["./serverless"]` points there. npm dependencies are inlined rather than left
external, because the traced function lands under `apps/docs-site/`, where pnpm has linked
neither `pg` nor `jose`; an external import would resolve during the build here and fail in
the deployment. A `types` condition still points at `src/serverless.ts`, so `tsc` keeps
checking real source. `pnpm service` is untouched: it runs the TypeScript entrypoint through
tsx and never reads `dist/`.

Two guards sit in the build so this cannot rot quietly: the build fails if anything but a
Node builtin survives as an external import, and `scripts/check-function-imports.mjs` (below)
resolves and loads what the function actually imports.

The bundle needs one thing that is easy to miss. `pg` and `ws` are CommonJS and call
`require()` at load time; esbuild's ESM output routes those through a shim that throws
`Dynamic require of "events" is not supported` unless a real `require` is in scope, so the
build adds a `createRequire` banner. Without it the bundle builds, resolves, and dies on
first import, which is the same shape of failure as the one it replaces. The import check
caught this, which is a fair argument for the import check.

### `GET /health`

Added to the router in `apps/service/src/http.ts`, alongside the older `/healthz` spelling,
which still works. No auth, no store call. The body names the service:

```json
{"ok":true,"data":{"status":"ok","service":"crosscode-service"}}
```

That field matters. A request that misses the API and falls through to the static site also
returns 200, and only the body tells the two apart.

The serverless adapter answers the probe before it reads any configuration
(`apps/service/src/serverless.ts`), so a function that loaded but has no `DATABASE_URL` can
still report that it is running. That is a different fault from a function that could not be
imported, and the two get fixed in different places. Routes that need the database still
fail, so the probe cannot pass for a service that is really down. This is exactly what the
preview deployment below shows.

## Problem 2: `@crosscode/cli` is not published

`npm view @crosscode/cli` returns `404 Not Found`. The package is now verified publish-ready.
Nothing in `package.json` needed changing: `files`, `bin`, `engines`, `repository`, `license`,
`description`, `keywords` and `publishConfig` are all correct for a public first release. The
field-by-field check is in the checklist document.

`npm pack` produces exactly what it should:

```
npm notice 📦  @crosscode/cli@0.1.0
npm notice Tarball Contents
npm notice 1.1kB LICENSE
npm notice 37.6kB README.md
npm notice 161.4kB dist/cli.js
npm notice 534.9kB dist/cli.js.map
npm notice 230.8kB dist/daemon.js
npm notice 498.9kB dist/daemon.js.map
npm notice 74.3kB dist/mcp.js
npm notice 395.3kB dist/mcp.js.map
npm notice 2.5kB package.json
npm notice package size: 463.0 kB
npm notice unpacked size: 1.9 MB
npm notice total files: 9
```

Installed into a scratch directory outside the repository, with nothing but Node 24.18.1:

```
$ cd /tmp/crosscode-scratch && npm init -y && npm install .../crosscode-cli-0.1.0.tgz
found 0 vulnerabilities
$ ./node_modules/.bin/crosscode --version
0.1.0
$ ./node_modules/.bin/crosscode --help
Usage: crosscode [options] [command]

Local-first coordination layer for multi-agent git checkouts
...
Commands:
  start [options]               set this checkout up end to end: configure it,
                                sign in, attach a workspace, start the daemon,
                                and register the MCP server
$ git init -q . && printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize", ...}' | ./node_modules/.bin/crosscode-mcp
{"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{},"resources":{}},"serverInfo":{"name":"crosscode-mcp","version":"0.1.0"}},"jsonrpc":"2.0","id":1}
```

`npx` resolves the default bin from the tarball:

```
$ cd /tmp/npx-scratch && npx -y "file:/.../crosscode-cli-0.1.0.tgz" --version
npm notice run 'crosscode' --version
0.1.0
```

The `file:` prefix is required. `npx -y /abs/path.tgz` tries to execute the tarball as a
program and fails with `Permission denied`, which is worth knowing before you debug it at the
wrong layer.

One rough edge, in code this workstream does not own: `crosscode-mcp` outside a git checkout
exits with a raw Node stack trace ending in `Command failed: git -C /tmp/... rev-parse
--show-toplevel`. It is not a publishing blocker and the first thing most people will do is
run it inside a repository, but it is a bad first impression. That lives in
`apps/mcp-server`/`apps/cli`, so it belongs to whoever owns those.

## Problem 3: a green build must not mean a dead API

Two checks, because neither covers the other.

**`scripts/check-function-imports.mjs`**, wired into `ci.yml` right after `pnpm build`.
It resolves every import in the Vercel function the way the deployment resolves it, then
loads what it finds. No deployment needed. Against a fixture importing a workspace package
whose entry is still TypeScript, which is the code as it shipped:

```
$ node scripts/check-function-imports.mjs "$PWD/apps/docs-site/api/_broken-fixture.ts"
FAIL .../api/_broken-fixture.ts -> @crosscode/service: resolves to
 .../apps/service/src/http.ts, which Node cannot load. Build it to JavaScript.

1 import(s) will not load in a deployed function.
exit=1
```

Against the real function on this branch:

```
$ node scripts/check-function-imports.mjs
ok   @crosscode/service/serverless -> .../apps/service/dist/serverless.js

Every function import resolves to loadable JavaScript.
exit=0
```

**`scripts/smoke-deployment.sh`**, run by `.github/workflows/smoke.yml` on every Vercel
`deployment_status`, on a six-hourly schedule, and on demand. It requires `/api/health` to
return 200 and name the service, and `/v1/memberships` to answer something other than 5xx
without credentials. Against production as it stands today:

```
$ ./scripts/smoke-deployment.sh https://www.getcrosscode.dev
FAIL GET https://www.getcrosscode.dev/api/health -> 500
A server error has occurred
FUNCTION_INVOCATION_FAILED
FAIL GET https://www.getcrosscode.dev/v1/memberships -> 500 (the router itself is broken)
2 smoke check(s) failed against https://www.getcrosscode.dev
exit=1
```

## The preview deployment

Deployed from this working tree with `npx vercel deploy --archive=tgz`:
`https://crosscode-et8n4yxsm-amsultan2010s-projects.vercel.app`. Vercel Authentication
protects preview URLs, so the requests below carry a share cookie.

```
$ curl ... "$B/api/health"
GET /api/health -> 200
{"ok":true,"data":{"status":"ok","service":"crosscode-service"}}

$ curl ... "$B/v1/memberships"
GET /v1/memberships -> 500
```

The 500 is no longer an import failure. The runtime log names the cause exactly:

```
Error: DATABASE_URL is required
    at required (file:///var/task/apps/service/dist/serverless.js:17382:21)
    at buildHandler (file:///var/task/apps/service/dist/serverless.js:17350:23)
    at default (/vercel/path0/apps/docs-site/api/[...path].ts:35:9)
```

Compare the same log line before the fix, from the first preview I deployed:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'/var/task/apps/docs-site/node_modules/@crosscode/service/src/serverless.ts'
```

The stack now runs through `/var/task/apps/service/dist/serverless.js`, real JavaScript
inside the real Vercel runtime. That is the import fix proven in production conditions.

### Set the service environment variables

`vercel env ls` on the `crosscode` project lists only `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY`, both client-side. The service needs its own, and nothing else will
work until they exist:

```bash
cd /path/to/crosscode
vercel link --project crosscode

# The Supabase POOLED connection string, port 6543, not the direct 5432 one. A function
# platform opens a pool per instance and the direct port runs Postgres out of connections.
vercel env add DATABASE_URL production
vercel env add DATABASE_URL preview

vercel env add SUPABASE_URL production     # https://rzsslbmahvoesjxmgefr.supabase.co
vercel env add SUPABASE_URL preview

# Optional, and needed only for browser callers: the site origin, comma separated.
vercel env add CROSSCODE_ALLOWED_ORIGINS production   # https://www.getcrosscode.dev

vercel deploy --prod        # or merge this branch and let the git integration deploy
./scripts/smoke-deployment.sh https://www.getcrosscode.dev
```

The smoke script is the check that this worked. Until `DATABASE_URL` is set, it will report
`/api/health` passing and `/v1/memberships` failing, which is the split the health route was
built to give you.

## Success criteria

| # | Criterion | Result |
| --- | --- | --- |
| 1 | `pnpm build` passes | pass, exit 0 |
| 2 | `pnpm test` passes, no new failures | pass, exit 0. 34 files passed / 9 skipped, 391 tests passed / 42 skipped, 0 failed |
| 3 | Clean-install import of `@crosscode/service/serverless` prints `function`, through JavaScript | pass, resolved path shown below |
| 4 | `/health` returns 200 with no auth and no database, proven by a unit test | pass |
| 5 | `npm pack`, install the tarball, `crosscode --version` | pass, output above |
| 6 | CI smoke check exists, fails on broken input and passes on good | pass, both shown above |
| 7 | `docs/status/2026-08-04-npm-publish-checklist.md` exists and is precise | written |

Criterion 3, run from `apps/docs-site`, which is the package that declares the dependency:

```
$ node --input-type=module -e "import('@crosscode/service/serverless').then(m => console.log(typeof m.createServerlessHandler))"
function
$ node --input-type=module -e "import { createRequire } from 'node:module'; console.log(createRequire(process.cwd() + '/api/x.ts').resolve('@crosscode/service/serverless'))"
/Users/.../cc-a-production-unblock/apps/service/dist/serverless.js
```

Criterion 4 has a unit test in `apps/service/src/http.test.ts` that hands the router a store
whose every method throws when called, so a database call fails the test rather than passing
against an obliging mock. Beyond the unit test, the built bundle was run against an empty
environment:

```
$ node -e "... createServerlessHandler({}) ..."
empty-env GET /health -> 200 {"ok":true,"data":{"status":"ok","service":"crosscode-service"}}
empty-env GET /v1/memberships -> 500 Error: DATABASE_URL is required
```

On criterion 2's baseline: `BUILD_INSTRUCTIONS.md` records 32 files / 369 tests, and that
paragraph warns it is a dated observation rather than a spec. I ran `pnpm build && pnpm test`
on the unmodified tree before starting and both exited 0, so the branch point was green; I
did not capture that run's counts, which was a mistake. What I can show is the delta:
`git diff HEAD~2 HEAD -- apps/service/src/http.test.ts` adds exactly one `it(` and no test
files, so 34 files / 390 tests is the count this branch started from. Zero failures either
way, which is the criterion.

## Not done, and why

- **`pnpm test:postgres` was not run.** No Docker on this machine (`docker info` fails), so
  the nine PostgreSQL-gated suites skipped, as they do in the plain `pnpm test` job. CI runs
  them. Nothing I changed touches the store, and coverage of `store.ts` is unchanged.
- **The `docker build` step in `ci.yml` was not exercised locally**, same reason.
- **Nothing was published to npm and no production deployment was promoted.** Both are yours.
- **`README.md` still says `npx @crosscode/cli start`**, which stays a dead link until you
  publish. That file belongs to another workstream, so I left it alone.
- **The preview deployments I created are protected by Vercel Authentication** and cannot be
  smoke-checked by an anonymous CI job. The `deployment_status` trigger in `smoke.yml` will
  therefore be useful for production and will report failures for protected previews. If you
  want previews covered too, enable Protection Bypass for Automation on the project and pass
  the token as an `x-vercel-protection-bypass` header; I did not change project protection
  settings.

## Files changed

```
.github/workflows/ci.yml           one step: run the function import check after build
.github/workflows/smoke.yml        new: post-deploy smoke on deployment_status, cron, dispatch
apps/docs-site/api/[...path].ts    comment only, explaining what the import must resolve to
apps/docs-site/vercel.json         buildCommand builds the serverless bundle before vite
apps/service/package.json          build script; exports["./serverless"] -> dist, types -> src
apps/service/src/http.ts           GET /health, sharing one sendHealth with the adapter
apps/service/src/http.test.ts      one test: /health, no auth, store that throws if touched
apps/service/src/serverless.ts     answer health before reading config; build handler lazily
package.json                       pnpm build also builds the serverless bundle
scripts/build-serverless.mjs       new: the bundle, with a self-contained-output assertion
scripts/check-function-imports.mjs new: resolve and load what the function imports
scripts/smoke-deployment.sh        new: two requests against a live deployment
```
