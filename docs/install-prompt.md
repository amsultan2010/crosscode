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
- Joining an existing workspace (so proposals from other people/agents show up)
  isn't wired into this prompt yet. It needs `CROSSCODE_SERVICE_URL` set in the
  MCP server's `env` block plus, in the worktree, either a prior sign-in
  (`crosscode login --email <e> --password <p>` — the headless path, since an
  agent has no browser) or a one-time pairing code (`crosscode join --pair
  <code>`, which needs no login at all). The daemon-side support already exists
  (`apps/mcp-server/src/bootstrap.ts` reads `CROSSCODE_SERVICE_URL` and checks
  for a logged-in session).
- Nothing here opens a web page, and nothing here needs one. Account creation is
  the only step that has a website form, and `crosscode signup --email <e>
  --password <p>` covers it from a terminal.
