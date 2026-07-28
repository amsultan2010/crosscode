# MCP client configuration

`apps/mcp-server` is a standards-compliant Model Context Protocol server built on
`@modelcontextprotocol/sdk`. It speaks MCP over stdio and proxies tool calls to the
local Crosscode daemon for the current worktree (see `crosscode daemon` /
`pnpm daemon`). Start the daemon for the worktree before connecting a client — the
MCP server reads the daemon's local connection descriptor
(`.git/crosscode/daemon.json`) and fails to start if no daemon is running.

The server is invoked as `crosscode-mcp` (see `apps/mcp-server/package.json`'s `bin`
entry) and takes no arguments; it discovers the repository from its working
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

## Running from source

Before `crosscode-mcp` is published/linked as a binary, any of the above can run
it directly from the repo with `tsx`, keeping `cwd` at the worktree root:

```json
{
  "command": "tsx",
  "args": ["/absolute/path/to/crosscode/apps/mcp-server/src/main.ts"]
}
```

## Available tools

`get_workspace_state`, `list_tasks`, `claim_task`, `claim_scope`, `publish_intent`,
`check_change_scope`, `submit_change_summary`, `list_remote_proposals`,
`request_handoff`, `announce_interface_change`, `request_validation`,
`create_checkpoint` — see BUILD_INSTRUCTIONS.md section 13 for the capability this
tool surface implements. Tool input schemas are generated from the Zod request
schemas in `packages/protocol`, so `tools/list` always reflects the daemon's
actual request validation.
