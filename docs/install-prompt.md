# Crosscode install prompt

This is the text meant to be copy-pasted directly into a coding agent's chat (Claude
Code, Codex CLI, OpenCode, Cursor, or any other MCP-capable agent). The agent has
shell and file-edit access in the current project, so it can complete every step
itself with no manual work from the person pasting it. This exact text is also what
the marketing site's "Install" button copies to the clipboard — keep both in sync.

## The prompt

````text
Set up Crosscode for this project. Crosscode is a local-first safety daemon that
watches Git and filesystem activity and exposes itself to me as an MCP server, so
you (my coding agent) can coordinate safely with other people and agents working in
other checkouts of this same repository. Do the following:

1. Check whether `~/.crosscode` already exists.
   - If it does not exist: run `git clone https://github.com/amsultan2010/crosscode.git ~/.crosscode`.
   - If it does exist: run `git -C ~/.crosscode pull --ff-only`.
2. Make sure pnpm is available (`pnpm --version`). If it is not installed, run
   `npm install -g pnpm`.
3. Run `pnpm install` inside `~/.crosscode`.
4. Determine the absolute path of this project's Git root (`git rev-parse --show-toplevel`
   from the current directory). Call this `$PROJECT_ROOT`.
5. Add a `crosscode` MCP server entry to whichever MCP config applies to you:
   - If you are Claude Code: create or edit `.mcp.json` in `$PROJECT_ROOT`.
   - If you are Codex CLI: create or edit `~/.codex/config.toml`.
   - If you are OpenCode: create or edit `opencode.json` in `$PROJECT_ROOT` (or the
     global OpenCode config).
   - If you are another MCP-capable agent: use whatever MCP config file or command
     you use to register a local stdio MCP server.

   Use these exact values (do not change them):
   - command: `~/.crosscode/node_modules/.bin/tsx` (expand `~` to the real home
     directory path)
   - args: `["~/.crosscode/apps/mcp-server/src/main.ts"]` (expand `~` here too)
   - cwd: `$PROJECT_ROOT`

   For Claude Code's `.mcp.json`, that looks like:
   ```json
   {
     "mcpServers": {
       "crosscode": {
         "command": "/absolute/home/.crosscode/node_modules/.bin/tsx",
         "args": ["/absolute/home/.crosscode/apps/mcp-server/src/main.ts"],
         "cwd": "$PROJECT_ROOT"
       }
     }
   }
   ```
   Merge this into the file if it already has other `mcpServers` entries; don't
   overwrite unrelated entries.

6. Tell me the config was written and that I need to restart/reload you (or
   reconnect MCP servers) for the new "crosscode" server to be picked up.
7. Once reconnected, call the `get_workspace_state` tool once to confirm it works.
   You do not need to run any install/init command yourself first — the first tool
   call automatically creates a local Crosscode identity for this checkout and
   starts its background daemon if one isn't already running. If the call fails,
   report the exact error back to me instead of guessing at a fix.
````

## Notes for whoever is embedding this prompt

- The clone target (`~/.crosscode`) is a fixed, shared location so re-running the
  prompt in a second project reuses the same installation instead of re-cloning.
- Nothing here requires `pnpm build` — the MCP server and daemon both run directly
  from TypeScript source via `tsx`, so `pnpm install` is the only setup step.
- Joining an existing team workspace (so proposals from other people/agents show
  up) isn't wired into this prompt yet — that needs `CROSSCODE_SERVICE_URL` and
  `CROSSCODE_ENROLLMENT_TOKEN` set in the MCP server's `env` block, which requires
  a running coordination service and an issued enrollment token. The daemon-side
  support for this already exists (`apps/mcp-server/src/bootstrap.ts` reads both
  variables automatically); only the hosted signup/billing flow that issues the
  token is still pending (see BUILD_INSTRUCTIONS.md and the project's near-term
  plan for the hosted service, Clerk auth, and Stripe billing).
