# onboarding: frozen contracts

how a person gets from "no account" to "a checkout syncing", and what each component may
assume about the others. the cli, the website's join page, and the coordination service are
built independently against this page, so no component changes a contract here
unilaterally. the shapes themselves live in `packages/protocol/src/sync.ts`; this page is
the sequence and the rules around them.

the whole budget is **two pasted lines**. anything that adds a third is wrong.

## the flow

```
Alice:  crosscode start           → device-code sign-in, project created, daemon up,
                                    agent wired
        crosscode invite          → https://www.getcrosscode.dev/join/7f3a9c2e

Bob:    opens the link, signs in with GitHub
        the page verifies he has access to the repo, then shows him:

            git clone git@github.com:acme/app.git && cd app
            crosscode join CC-7F3A-9C2E
```

bob's `join` does everything `start` does, minus creating a project.

## contract a: identity

github oauth, and nothing else. no password, no email/password fallback, no headless
sign-in path.

that is a deliberate constraint rather than an omission: invite redemption has to prove the
invitee can actually read the repository, and the only party that can answer that is github.
an identity provider that could not answer it would make the invite meaningless.

**the handshake is a device-code flow.** the cli has no browser and no callback server; it
gets a code, prints a url, and polls.

```
CLI  ──POST /v1/auth/github/device──▶  service
     ◀── { deviceCode, userCode, verificationUrl, intervalSeconds, expiresInSeconds }

user ──▶ https://www.getcrosscode.dev/device
      ──▶ signs in with GitHub
      ──▶ types userCode; the page binds it to the signed-in session

CLI  ──POST /v1/auth/github/device/token { deviceCode }──▶
     ◀── { status: "pending" }        …at intervalSeconds, until…
     ◀── { status: "complete", session: { accessToken, refreshToken, expiresAt } }
```

two codes, and the split is the point. `deviceCode` is the cli's secret and is never shown
to anyone; `userCode` is short enough to read off a terminal and type into a page, and on
its own it grants nothing. the service stores a hash of the device code, not the code. both
expire together, in about fifteen minutes, and the pair is single-use.

the first two routes are unauthenticated by definition (the whole point is that the caller
has no session yet) so they are the only routes exempt from the bearer check. the poll
route is rate-limited, because it is the one endpoint an attacker can hit without
credentials.

`session` is the shape already pinned by `syncDaemonConfig.service.session` in
`packages/protocol/src/sync.ts`. sign-in produces it; nothing downstream knows or cares how.

because the browser and the terminal are only joined by a typed code, they do not have to
be the same machine. that is what makes `crosscode start` work over ssh, and `--no-browser`
prints the url rather than trying to open one.

a `user` is one github account. the cli stores the resulting session mode-`0600` in
`<git-dir>/crosscode/config.json` (`syncDaemonConfig.service.session`), preferring the os
keychain for the refresh token where one exists. tokens are never printed, in `--json` mode
or out of it.

## contract b: projects

a project is one repository, keyed on `owner/repo` in `createProjectRequest.repo`, which the
schema constrains to that shape. `crosscode start` creates the project the first time and
attaches to the existing one afterwards; it is idempotent, and re-running it in a configured
checkout only reports state and makes sure the daemon is up.

a **room** is one project plus one branch name. two checkouts sync only when both match.
different branches do not sync, and that is a feature: switching branches is how you opt out
without stopping anything.

## contract c: invites

`POST /v1/invites` takes a `projectId` and an optional `expiresInHours` (default 168, max
720) and returns a `syncInvite`:

```jsonc
{ "code": "CC-7F3A-9C2E",                          // the human-typed form
  "url": "https://www.getcrosscode.dev/join/7f3a9c2e", // what Alice sends
  "projectId": "…", "repo": "acme/app", "expiresAt": "…" }
```

the code is uppercase, `CC-XXXX-XXXX`, and the regex in the contract is what both sides
validate against. store only a hash of it, never the plaintext.

`POST /v1/invites/:code/redeem` runs after the redeemer has signed in with github, and
**must verify that the redeeming github account has access to `repo`** before it returns
anything. it answers:

```jsonc
{ "projectId": "…", "repo": "acme/app", "cloneCommand": "git clone git@github.com:acme/app.git" }
```

`cloneCommand` comes from the service rather than being assembled by the page, so the two
lines bob pastes are the two lines the service intends. an expired, unknown, or
already-consumed code is answered identically, so redemption is not an oracle. rate-limit by
ip.

verifying repo access needs a github token belonging to the *redeemer*, not to us and not
to the inviter, and a supabase session does not carry one durably. however that token is
obtained, the check is not optional and must not degrade to "the code was valid": it is the
only thing standing between a forwarded invite code and a private repository.

the join page's whole job is: sign in, redeem, show the two lines. it reads and writes no
other sync state. the only other page on the site that touches a session is `/device`,
which binds a cli sign-in and does nothing else.

## contract d: replicas and cursors

`POST /v1/replicas` registers this checkout for a `(projectId, branch)` pair and returns
`{ replicaId, cursor }`. `cursor` is where to resume from; `0` means a fresh replica with no
history. the daemon calls it automatically on first start with a signed-in session.

from then on the cursor is the only piece of sync state that matters: the daemon publishes
with `POST /v1/changes`, catches up with `GET /v1/changes?since=`, and streams over
`/v1/stream`. a `since` older than retention is answered with `cursor-too-old`, which the
daemon must treat as "resync from full content", never as "nothing new".

## contract e: what `start` and `join` install

both commands leave the checkout in the same state, and both are idempotent:

1. a signed-in session and a project attachment (`syncDaemonConfig`).
2. a running daemon for the checkout, auto-restarting on crash.
3. the mcp server registered with the agent config that is present.
4. the `crosscode` skill copied into the agent's skills directory.
5. the pre-edit hook registered for claude code, and for codex where its config format is
   recognized. the command is `crosscode-mcp hook`, because the hook is a subcommand of the mcp
   entrypoint, not a sixth cli command.

steps 3 to 5 are described in [mcp-clients.md](./mcp-clients.md). any of them failing is
reported but does not fail the command: syncing works without an agent attached, and mcp
alone works without hooks.

## what is not in onboarding

no workspaces, no seats, no roles, no pairing codes, no device approval, no key exchange, no
plan selection, no team creation step. a project and its members are the whole model.
