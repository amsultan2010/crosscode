# Publishing `@crosscode/cli` to npm

Written 2026-08-04. Everything up to `npm publish` has been run and verified on this branch.
`npm publish` itself needs an interactive login and an npm account that owns the `@crosscode`
scope, so it is yours to run.

Current state: `npm view @crosscode/cli` returns 404. `README.md` opens with
`npx @crosscode/cli start`, so the front door is a dead link until this is done.

## 0. Prerequisites

- Node 24 and pnpm 11 (`node --version`, `pnpm --version`).
- An npm account with two-factor authentication enabled.
- A clean checkout of the branch you intend to publish from, with nothing uncommitted.

## 1. Create the `@crosscode` scope

The scope does not exist yet, and it cannot be created from the CLI. Open
<https://www.npmjs.com/org/create>, create an organisation named `crosscode`, and choose the
free plan. Free organisations can publish unlimited public packages; the paid tier only buys
private ones.

Check it worked:

```bash
npm org ls crosscode
```

That lists you as an owner. If the name is taken by someone else, the package name in
`package.json` has to change before anything below will work.

## 2. Log in

```bash
npm login
npm whoami          # prints your username
npm access list packages crosscode 2>/dev/null || true   # empty is correct: nothing published yet
```

## 3. Confirm the name is free

```bash
npm view @crosscode/cli
```

Expected: `404 Not Found`. Anything else means the name is taken and you should stop.

## 4. Build and inspect the tarball

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
npm pack
```

`npm pack` prints the file list. It must be exactly these nine entries, and nothing else:

```
LICENSE
README.md
dist/cli.js
dist/cli.js.map
dist/daemon.js
dist/daemon.js.map
dist/mcp.js
dist/mcp.js.map
package.json
```

Verified 2026-08-04: 463.0 kB packed, 1.9 MB unpacked, 9 files. If `dist/` is missing, `pnpm
build` did not run. If source files appear, something changed `files` in `package.json`.

## 5. Prove the tarball works before publishing it

This installs the exact bytes npm would serve, outside the repository, with no workspace
links to fall back on:

```bash
rm -rf /tmp/crosscode-publish-check && mkdir -p /tmp/crosscode-publish-check
cd /tmp/crosscode-publish-check
npm init -y >/dev/null
npm install /path/to/crosscode/crosscode-cli-0.1.0.tgz
./node_modules/.bin/crosscode --version    # 0.1.0
./node_modules/.bin/crosscode --help       # usage, starting with `crosscode start`
git init -q .                              # crosscode-mcp requires a git checkout
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  | ./node_modules/.bin/crosscode-mcp
```

The last command prints one line of JSON naming `crosscode-mcp` and version `0.1.0`. Run it
outside a git repository and it exits with a raw Node stack trace ending in `Command failed:
git rev-parse --show-toplevel`, which is ugly but not a publishing blocker.

Then check the `npx` path, which is what `README.md` tells strangers to run:

```bash
cd /tmp && npx -y "file:/path/to/crosscode/crosscode-cli-0.1.0.tgz" --version
```

Prints `0.1.0`, having resolved the default `crosscode` bin. Note the `file:` prefix: without
it, npx tries to execute the tarball as a program and fails with `Permission denied`.

## 6. Dry run, then publish

```bash
cd /path/to/crosscode
npm publish --dry-run --access public     # same file list as step 4, no upload
npm publish --access public               # runs prepublishOnly, which runs pnpm build
```

Use `npm`, not `pnpm publish`: pnpm adds its own git-state checks that add nothing here.
`--access public` is also set in `publishConfig`, so it is belt and braces. You will be asked
for your 2FA code.

## 7. Verify the published package from a clean machine

Wait about a minute for the registry to serve it, then, ideally on a different machine or at
least with an empty npm cache:

```bash
npm view @crosscode/cli version                 # 0.1.0
npm view @crosscode/cli dist.tarball

rm -rf /tmp/crosscode-clean && mkdir -p /tmp/crosscode-clean && cd /tmp/crosscode-clean
export npm_config_cache="$(mktemp -d)"          # ignore anything cached locally
npx -y @crosscode/cli --version                 # 0.1.0
npx -y @crosscode/cli --help
```

The real end-to-end check is the command in the README:

```bash
cd "$(mktemp -d)" && git init -q .
npx -y @crosscode/cli start
```

That one needs a Crosscode account and a reachable hosted service, so run it after the API is
serving (see `docs/status/2026-08-04-production-unblock.md`).

## 8. If something is wrong after publishing

```bash
npm unpublish @crosscode/cli@0.1.0        # only within 72 hours of publishing
npm deprecate @crosscode/cli@0.1.0 "Broken release, use 0.1.1"   # after that
```

Prefer publishing 0.1.1 over unpublishing. Unpublishing a version means npm will never accept
that version number again.

## Package metadata, as checked on 2026-08-04

Everything a public first release needs is present in the root `package.json`, so nothing in
it had to change:

| Field | Value | Verdict |
| --- | --- | --- |
| `name` | `@crosscode/cli` | needs the scope from step 1 |
| `version` | `0.1.0` | fine for a first release |
| `description` | one sentence on what it does | fine |
| `license` | `MIT`, with `LICENSE` in the tarball | fine |
| `repository` / `homepage` / `bugs` | all point at `github.com/amsultan2010/crosscode` | fine |
| `keywords` | 7 entries | fine |
| `files` | `["dist"]` | correct; npm adds README, LICENSE and package.json itself |
| `bin` | `crosscode` and `crosscode-mcp`, both `dist/cli.js` | correct, and one file per bin is what makes `npx @crosscode/cli` resolve |
| `engines` | `node >=24` | matches `.node-version` and the esbuild target |
| `publishConfig` | `{"access": "public"}` | required for a scoped package |
