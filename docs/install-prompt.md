# Crosscode install prompt

This is the text meant to be copy-pasted directly into a coding agent's chat (Claude
Code, Codex CLI, OpenCode, Cursor, or any other MCP-capable agent). The agent has
shell and file-edit access in the current project, so it can complete every step
itself with no manual work from the person pasting it. This exact text is also what
the marketing site's "Install" button copies to the clipboard, so keep both in sync.

`crosscode-cli` is not on npm yet, so the `npx` lines below fail with a 404 until it is
published. The prompt is written for the published package and needs no edit when that
lands.

## The prompt

````text
Set up Crosscode for this project. Crosscode keeps everyone working on this
codebase in sync: a local daemon watches Git and filesystem activity and exposes
itself to you (my coding agent) as an MCP server, so you can see what my teammates
and their agents are doing in their own checkouts, and they can see what we do here,
within seconds instead of at pull-request time. Their work arrives as proposals we
review, never as writes into our files. Do the following:

1. Check that Node 24 or newer is available (`node --version`). If it is not, stop
   and tell me, because everything below needs it.
2. From this project's Git root, run:

   ```
   npx --yes crosscode-cli start --no-browser
   ```

   `start` does the whole setup: it configures this checkout, signs me in, attaches
   it to my personal workspace, starts the background daemon, and writes the
   Crosscode MCP server into this project's MCP config. It registers with Claude
   Code (`.mcp.json`) by default; pass `--mcp cursor`, `--mcp gemini`, or
   `--mcp opencode` if I use one of those instead.
3. `--no-browser` makes it print a sign-in URL instead of trying to open a browser
   you cannot see. Show me that URL and wait. I have to open it and sign in, or
   create an account, before the command finishes. Do not try to sign in for me,
   and do not ask me for my password.
4. If I say I would rather not use a browser at all, run it headlessly instead:
   `npx --yes crosscode-cli start --email <my email> --password <my password>`,
   using credentials I give you. If I have no account yet, that path needs
   `npx --yes crosscode-cli signup --email <e> --password <p>` first.
5. Once `start` reports success, tell me the config was written and that I need to
   restart/reload you (or reconnect MCP servers) for the new "crosscode" server to
   be picked up.
6. Once reconnected, call the `get_workspace_state` tool once to confirm it works.
   If the call fails, report the exact error back to me instead of guessing at a
   fix.

If I am joining a teammate's workspace rather than using my own, run
`npx --yes crosscode-cli join --invite <code>` with the invite code I give you
after step 5, then restart as above.
````

## Notes for whoever is embedding this prompt

- Nothing is cloned and nothing is built. `npx` fetches the published
  `crosscode-cli` package, whose `dist/` bundle carries the CLI, the daemon, and
  the MCP server. Node 24 is the only requirement.
- The MCP entry `start` writes points at `npx` when Crosscode is not installed
  durably, and at the short `crosscode-mcp` command when it is. See
  `resolveMcpLaunch` in `apps/cli/src/mcp-config.ts`. Suggest
  `npm install -g crosscode-cli` to anyone who will use it daily: agent sessions
  then launch from a stable path instead of re-resolving through npm's cache.
- `--no-browser` is there because an agent has no browser, and the default flow would
  otherwise open a tab nobody is looking at. `crosscode start` refuses to try when it
  has no TTY rather than hanging on one.
- Codex CLI's MCP config is TOML (`~/.codex/config.toml`) and `start` does not
  write it, because merging TOML into a global file holding model, approval, and
  sandbox settings is not something to do without a TOML parser. Codex users add
  the three-line entry from [`mcp-clients.md`](./mcp-clients.md) by hand.
- Creating the account is the only step with a website form, and `crosscode signup
  --email <e> --password <p>` covers it from a terminal for anyone who prefers that.
