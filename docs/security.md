# Security model

Crosscode moves uncommitted file contents between machines. Three things carry that:
a per-checkout daemon, a coordination service, and the local clients that talk to the
daemon. This page is what defends each, and what does not.

## Authentication

Sign-in is **GitHub OAuth**, and there is no other path. Members authenticate through the
website; the CLI receives the resulting session on a loopback callback and stores it
mode-`0600` in `<git-dir>/crosscode/config.json`, preferring the OS keychain for the refresh
token where one exists (macOS `security`, Linux `secret-tool`).

- The callback server binds `127.0.0.1` on an ephemeral port, never `0.0.0.0` and never a
  fixed port, so nothing off the machine can reach it and nothing can squat the port in
  advance.
- The CLI generates a random `state`, puts it in the URL it opens, and rejects a callback
  that does not echo it. That is what stops another local process, or a page the user was
  tricked into opening, from POSTing a session into a CLI that happens to be waiting.
- It accepts exactly one callback and shuts down; no callback inside the timeout is an
  error, not an open listener.
- Tokens are never printed, in `--json` mode or out of it, so they stay out of terminal
  scrollback, CI logs, and agent transcripts. There is no `CROSSCODE_TOKEN` to set or leak.

Every service request re-derives project membership server-side for the authenticated user
rather than trusting a scope in the token, so a removed member loses access on their next
request instead of when a token expires.

## Invite redemption

An invite code is a bearer secret, so the interesting check is the one after it:
**redemption verifies through GitHub that the redeeming account actually has access to the
repository.** A valid code from someone with no repo access is refused. This is the reason
identity is GitHub-only.

Codes are stored hashed, single-use, and expiring. Unknown, expired, and already-consumed
codes are answered identically so the endpoint is not an oracle, and redemption is
rate-limited by IP.

## The daemon's local API

The daemon binds loopback only and writes a mode-`0600` connection descriptor
(`<git-dir>/crosscode/daemon.json`) holding its port and a random secret. Every local
request carries that secret as a bearer token. Clients refuse a descriptor whose permissions
are wider than owner-only or which is owned by another user, so a shared machine cannot hand
one user's descriptor to another.

The MCP server and the pre-edit hook hold no state and no credentials of their own; they
read that descriptor and forward.

The daemon ↔ filesystem boundary is fully trusted. The daemon reads and writes the checkout
it manages, with no sandbox between the two.

## What is never sent

Enforced before a change is captured, not filtered afterwards:

- **Untracked files.** Only files Git tracks are eligible.
- **A hard secret denylist**: `.env*`, `*.pem`, `*.key`, and credential-shaped paths, even
  when tracked. Real-time syncing an `.env` would be a serious incident, so this check is
  the earliest one in the pipeline.
- **Anything outside the working tree.** Symlinks that leave the checkout are refused.

## Integrity on receive

The receiver verifies every change before applying it: the content must hash to the
`contentHash` on the wire, and the merge base must resolve to the `baseHash` the sender
recorded. A change that fails either is not applied.

That check has to be the receiver's rather than the service's. A service willing to
substitute content would substitute the hash beside it, so a server-side check is a
garbage-in filter and nothing more.

## Encryption

TLS in transit, encryption at rest under keys the service manages. **There is no end-to-end
encryption**, no device pairing, and no key exchange. The service can read the file contents
it stores; [privacy.md](./privacy.md) says so in the same words.

We built E2E once and removed it. It bought a real property and cost a device-pairing
ceremony, a keyring, epochs, rotation, and recovery paths, for a product whose durable
artifact is a Git repository the user already has. The honest trade for this product is
fewer moving parts and a plain statement of what we hold.

## Service ↔ database

Row Level Security is on from the first migration. The service connects with a
least-privilege role that cannot rewrite history; the retention sweep that deletes aged
changes runs on a separate connection, so no request-handling path can reach a connection
able to erase history.

## What a malicious member can do

Given a valid session and project membership:

- Publish changes to files in that project and read the changes other members publish. That
  is the product; a member of a project is someone you have given your working tree to.
- See presence for the project: branch and recently touched paths.

What they cannot do:

- Reach another project. Every read and write is scoped to a project the caller belongs to,
  and there is no cross-project query path.
- Impersonate another member or replica. Ingest checks that the change's `replicaId` belongs
  to the authenticated user.
- Write outside the working tree, or touch commits, branches, or remotes on a receiving
  machine. The receiver applies working-tree file writes only, under the rules in
  [architecture.md](./architecture.md).
- Force a write onto a file someone is actively editing. Hot-file deferral holds it.

## Threat model, stated plainly

Holds against: an attacker on the network (TLS); another local user on a shared machine
(loopback binding, `0600` descriptors and config); a member removed from a project (access
ends on their next request); a service that corrupts stored content (receiver-side hash
verification); an invite forwarded to someone without repo access (GitHub check).

Does **not** hold against: a compromised member device, which holds the checkout and the
session; a member who leaves with what they already synced; anyone with production access to
our service, who can read stored file contents; traffic analysis of when you work and how
large your changes are.

Report vulnerabilities per [SECURITY.md](https://github.com/amsultan2010/crosscode/blob/main/SECURITY.md),
never in a public issue.
