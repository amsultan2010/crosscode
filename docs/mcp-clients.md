# MCP client configuration

`apps/mcp-server` is a standards-compliant Model Context Protocol server built on
`@modelcontextprotocol/sdk`. It speaks MCP over stdio and proxies tool calls to the
local Crosscode daemon for the current worktree.

You do not need to start the daemon yourself. On first connection, the MCP server
calls `ensureDaemonRunning` (`apps/mcp-server/src/bootstrap.ts`): if no daemon is
already listening for the worktree, it writes a local replica identity if one
doesn't exist yet, spawns the daemon as a detached background process, and waits
for it to come up before serving any tool calls. If `CROSSCODE_SERVICE_URL` is set
in the server's `env` but the worktree has no logged-in Supabase session yet
(no prior `crosscode -- login`), bootstrap fails fast with an explicit error
asking you to log in first rather than guessing at a fix. The daemon keeps
running in the background after the MCP client disconnects, so it survives
individual agent sessions.

The server takes no arguments; it discovers the repository from its working
directory, so each client must launch it with `cwd` set to the worktree root.

## Claude Code

Add a project- or user-scoped server entry, for example in `.mcp.json` at the
worktree root:

```json
{
  "mcpServers": {
    "crosscode": {
      "command": "crosscode-mcp",
      "args": []
    }
  }
}
```

Or register it with the CLI from the worktree root:

```bash
claude mcp add crosscode -- crosscode-mcp
```

## Codex CLI

Add a server entry to `~/.codex/config.toml`:

```toml
[mcp_servers.crosscode]
command = "crosscode-mcp"
args = []
```

Codex CLI spawns MCP servers with the working directory of the Codex session, so
run Codex from the worktree root (or the directory it operates in) so the server
can find the local daemon connection descriptor.

## OpenCode

Add a server entry to `opencode.json` (project or global config):

```json
{
  "mcp": {
    "crosscode": {
      "type": "local",
      "command": ["crosscode-mcp"],
      "enabled": true
    }
  }
}
```

## Gemini CLI

Add a server entry to `.gemini/settings.json` (project) or `~/.gemini/settings.json`
(user):

```json
{
  "mcpServers": {
    "crosscode": {
      "command": "crosscode-mcp",
      "args": []
    }
  }
}
```

## Cursor

Add a server entry to `.cursor/mcp.json` at the worktree root (project-scoped) or
`~/.cursor/mcp.json` (available in every project):

```json
{
  "mcpServers": {
    "crosscode": {
      "command": "crosscode-mcp",
      "args": []
    }
  }
}
```

## Running from source

Crosscode is not published to npm yet, so every client above runs it directly from
a cloned checkout of this repository with `tsx`, using the `tsx` binary installed
inside that checkout (so no global install is required) and `cwd` set to the
worktree you want Crosscode to manage:

```json
{
  "command": "/absolute/path/to/crosscode/node_modules/.bin/tsx",
  "args": ["/absolute/path/to/crosscode/apps/mcp-server/src/main.ts"],
  "cwd": "/absolute/path/to/your/project"
}
```

`/absolute/path/to/crosscode` is wherever you cloned this repository (after
`pnpm install`); `/absolute/path/to/your/project` is the Git repository you want
Crosscode to watch. This is exactly what `docs/install-prompt.md` generates.

All configs above are transcribed from each client's own published MCP
documentation and config schema (stdio server registration under an
`mcpServers`/`mcp_servers` block); none of them have been launched end-to-end
against a running Crosscode daemon in this environment.

## Available tools

The list below is generated from `apps/mcp-server/src/tool-catalog.ts` — the same
module the server uses to answer `tools/list` — via
`pnpm --filter @crosscode/mcp-server generate:docs`. Regenerate it after changing
any tool's description or input schema. See BUILD_INSTRUCTIONS.md section 13 for
the capability this tool surface implements. Tool input schemas are generated from
the Zod request schemas in `packages/protocol`, so `tools/list` always reflects the
daemon's actual request validation.

<!-- BEGIN GENERATED TOOL CATALOG (apps/mcp-server/src/generate-tool-docs.ts) -->

- **`get_workspace_state`** — Read the local daemon's workspace status: HEAD, branch, dirty state, and pending counts. Call this first to orient before claiming tasks, checking scope, or capturing changes.
- **`list_tasks`** — List tasks known to the local daemon. Call before claim_task to see if your work is already tracked, or after claim_task to confirm it registered.
- **`claim_task`** — Create a task, optionally scoped to a set of paths, so other agents can see what you're about to work on. Call before editing; use claim_scope afterward for finer-grained path claims tied to this task.
- **`claim_scope`** — Advertise a path claim against an existing task so other agents avoid the same files. Call after claim_task and before editing — check_change_scope is how other agents (and you) read these claims back.
- **`publish_intent`** — Capture the current working-tree edits as a durable transaction tagged with a general intent. This is the default of the three capture variants (publish_intent / submit_change_summary / announce_interface_change) — use it when the change is neither a specific summary nor an interface change. Call after making edits.
- **`check_change_scope`** — Check whether a set of paths overlaps existing claims or pending remote proposals before editing. Call this before writing to files to avoid colliding with another agent's claimed scope or an in-flight proposal.
- **`submit_change_summary`** — Capture the current working-tree edits as a durable transaction tagged as a change summary, for reporting what was done. One of three capture variants (publish_intent / submit_change_summary / announce_interface_change); call after edits, in place of publish_intent when you're summarizing completed work rather than stating intent.
- **`list_remote_proposals`** — List remote operations that are proposed and awaiting local review. Call periodically to discover incoming changes that may need request_validation or a response via submit_semantic_review.
- **`request_handoff`** — Request a handoff of a proposed operation to another participant for review. Call after publish_intent, submit_change_summary, or announce_interface_change has produced an operation you want someone else to accept or decline.
- **`announce_interface_change`** — Capture the current working-tree edits as a durable transaction tagged as an interface change. One of three capture variants (publish_intent / submit_change_summary / announce_interface_change); use this instead of the others when the edit changes a public API or contract other agents depend on.
- **`request_validation`** — Run a named validation profile and return its results. Call after making edits, before requesting a handoff or creating a checkpoint, to confirm the change is sound.
- **`create_checkpoint`** — Create a Git checkpoint of the current worktree without moving HEAD. Call after edits have been validated, to durably snapshot progress without committing to a branch.
- **`list_pending_semantic_reviews`** — List semantic reviews awaiting this agent's judgment: ambiguous change bundles the daemon needs reasoned about before it can proceed. Call periodically; each entry's requestId is answered with submit_semantic_review.
- **`submit_semantic_review`** — Submit this agent's semantic review for a pending requestId: classification, confidence, affected symbols, evidence, invariants to preserve, an optional proposed resolution, and whether it requires human approval. Call only after list_pending_semantic_reviews surfaces a requestId needing judgment.
- **`inspect_proposal`** — Fetch a proposed operation and a human-readable analysis of it. Call on an operationId from list_remote_proposals before diff_proposal or accept_proposal/reject_proposal, to understand what a proposal contains.
- **`diff_proposal`** — Get the per-path diff for a proposed operation: base/local/proposed content, classification, risk, and dependents. Call after inspect_proposal and before deciding to accept_proposal or reject_proposal, especially when requiresApproval or risk looks high.
- **`list_proposal_artifacts`** — List conflict artifacts recorded for a proposed operation. Call when diff_proposal shows conflicting or unmergeable changes, to see what the daemon captured about the conflict before you accept_proposal or reject_proposal.
- **`accept_proposal`** — Accept a proposed operation, applying it locally; pass reviewApprovals when a path required semantic-review sign-off. Call after inspecting it with inspect_proposal/diff_proposal — this is the terminal counterpart to reject_proposal.
- **`reject_proposal`** — Reject a proposed operation, discarding it without applying it locally. Call after inspecting it with inspect_proposal/diff_proposal — this is the terminal counterpart to accept_proposal.
- **`publish_branch`** — Publish accepted changes to a branch by running the named validation profile and pushing/committing the result; requires confirm: true since this is not easily reversible. Call request_validation first if you want a dry look at validation independent of publishing, and pass dryRun: true here to preview without publishing.

<!-- END GENERATED TOOL CATALOG -->

## Resources

The server also exposes an MCP resource, `crosscode://guidance/tool-sequencing`,
with agent-readable guidance on how the tools above relate to each other — the
same content is in `apps/mcp-server/src/resources.ts`. Any MCP client can read it
via `resources/list` and `resources/read` to learn the intended call sequence
without needing this doc.

`list_pending_semantic_reviews` and `submit_semantic_review` are how the AI
semantic reviewer (BUILD_INSTRUCTIONS.md section 12) is delegated to the
connected agent instead of an external AI provider: `list_pending_semantic_reviews`
takes no arguments and returns the pending review bundles awaiting judgment
(`GET /v1/semantic-reviews/pending`); `submit_semantic_review` takes a `requestId`
plus the same fields as `packages/core/src/semantic-review.ts`'s
`semanticReviewSchema` (`classification`, `confidence`, `affectedSymbols`,
`evidence`, `invariantsToPreserve`, an optional `proposedResolution`, and
`requiresHumanApproval`) and forwards them to
`POST /v1/semantic-reviews/:requestId/submit`.
