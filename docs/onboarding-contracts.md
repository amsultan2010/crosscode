# Onboarding: frozen contracts

How a person gets from "no account" to "a checkout syncing", and what each component may
assume about the others. The CLI, the website's join page, and the coordination service are
built independently against this page, so no component changes a contract here
unilaterally. The shapes themselves live in `packages/protocol/src/sync.ts`; this page is
the sequence and the rules around them.

The whole budget is **two pasted lines**. Anything that adds a third is wrong.

## The flow

```
Alice:  crosscode start           → GitHub sign-in, project created, daemon up, agent wired
        crosscode invite          → https://getcrosscode.dev/join/7f3a9c2e

Bob:    opens the link, signs in with GitHub
        the page verifies he has access to the repo, then shows him:

            git clone git@github.com:acme/app.git && cd app
            crosscode join CC-7F3A-9C2E
```

Bob's `join` does everything `start` does, minus creating a project.

## Contract A: identity

GitHub OAuth, and nothing else. No password, no email/password fallback, no headless
sign-in path.

That is a deliberate constraint rather than an omission: invite redemption has to prove the
invitee can actually read the repository, and the only party that can answer that is GitHub.
An identity provider that could not answer it would make the invite meaningless.

A `user` is one GitHub account. The CLI stores the resulting session mode-`0600` in
`<git-dir>/crosscode/config.json` (`syncDaemonConfig.service.session`), preferring the OS
keychain for the refresh token where one exists. Tokens are never printed, in `--json` mode
or out of it.

## Contract B: projects

A project is one repository, keyed on `owner/repo` in `createProjectRequest.repo`, which the
schema constrains to that shape. `crosscode start` creates the project the first time and
attaches to the existing one afterwards; it is idempotent, and re-running it in a configured
checkout only reports state and makes sure the daemon is up.

A **room** is one project plus one branch name. Two checkouts sync only when both match.
Different branches do not sync, and that is a feature: switching branches is how you opt out
without stopping anything.

## Contract C: invites

`POST /v1/invites` takes a `projectId` and an optional `expiresInHours` (default 168, max
720) and returns a `syncInvite`:

```jsonc
{ "code": "CC-7F3A-9C2E",                          // the human-typed form
  "url": "https://getcrosscode.dev/join/7f3a9c2e", // what Alice sends
  "projectId": "…", "repo": "acme/app", "expiresAt": "…" }
```

The code is uppercase, `CC-XXXX-XXXX`, and the regex in the contract is what both sides
validate against. Store only a hash of it, never the plaintext.

`POST /v1/invites/:code/redeem` runs after the redeemer has signed in with GitHub, and
**must verify that the redeeming GitHub account has access to `repo`** before it returns
anything. It answers:

```jsonc
{ "projectId": "…", "repo": "acme/app", "cloneCommand": "git clone git@github.com:acme/app.git" }
```

`cloneCommand` comes from the service rather than being assembled by the page, so the two
lines Bob pastes are the two lines the service intends. An expired, unknown, or
already-consumed code is answered identically, so redemption is not an oracle. Rate-limit by
IP.

The join page's whole job is: sign in, redeem, show the two lines. It reads and writes no
other sync state, and there is no other authenticated page on the site.

## Contract D: replicas and cursors

`POST /v1/replicas` registers this checkout for a `(projectId, branch)` pair and returns
`{ replicaId, cursor }`. `cursor` is where to resume from; `0` means a fresh replica with no
history. The daemon calls it automatically on first start with a signed-in session.

From then on the cursor is the only piece of sync state that matters: the daemon publishes
with `POST /v1/changes`, catches up with `GET /v1/changes?since=`, and streams over
`/v1/stream`. A `since` older than retention is answered with `cursor-too-old`, which the
daemon must treat as "resync from full content", never as "nothing new".

## Contract E: what `start` and `join` install

Both commands leave the checkout in the same state, and both are idempotent:

1. A signed-in session and a project attachment (`syncDaemonConfig`).
2. A running daemon for the checkout, auto-restarting on crash.
3. The MCP server registered with the agent config that is present.
4. The `crosscode` skill copied into the agent's skills directory.
5. The pre-edit hook registered for Claude Code, and for Codex where its config format is
   recognized.

Steps 3 to 5 are described in [mcp-clients.md](./mcp-clients.md). Any of them failing is
reported but does not fail the command: syncing works without an agent attached, and MCP
alone works without hooks.

## What is not in onboarding

No workspaces, no seats, no roles, no pairing codes, no device approval, no key exchange, no
plan selection, no team creation step. A project and its members are the whole model.
