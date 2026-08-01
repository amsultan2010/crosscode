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

`get_workspace_state`, `list_tasks`, `claim_task`, `claim_scope`, `publish_intent`,
`check_change_scope`, `submit_change_summary`, `list_remote_proposals`,
`request_handoff`, `announce_interface_change`, `request_validation`,
`create_checkpoint`, `list_pending_semantic_reviews`, `submit_semantic_review` —
see BUILD_INSTRUCTIONS.md section 13 for the capability this tool surface
implements. Tool input schemas are generated from the Zod request schemas in
`packages/protocol`, so `tools/list` always reflects the daemon's actual request
validation.

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
