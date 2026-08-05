# Crosscode install prompt

Text to paste into a coding agent's chat when you would rather it did the setup. The agent
has shell access in the project, so it can do every step itself. This is also what the
site's "Install" button copies, so keep both in sync.

## The prompt

````text
Set up Crosscode for this project. Crosscode syncs uncommitted working-tree files between
my teammates' checkouts and mine in real time: they edit, my copy updates within seconds,
and vice versa. It never touches commits, branches, or remotes. Do the following:

1. Check that Node 24 or newer is available (`node --version`). If it is not, stop and
   tell me, because everything below needs it.
2. From this project's Git root, run:

   ```
   npm install -g @crosscode/cli && crosscode start
   ```

   `start` does the whole setup: it signs me in with GitHub, attaches this checkout to a
   project, starts the background daemon, and installs the Crosscode MCP server, skill,
   and pre-edit hook for you. It is safe to re-run.
3. It will print a GitHub sign-in URL. Show it to me and wait — I have to open it and sign
   in before the command finishes. Do not try to sign in for me and do not ask me for
   credentials.
4. Once `start` reports success, tell me I need to restart you (or reconnect MCP servers)
   for the "crosscode" server to be picked up.
5. Once reconnected, call the `status` tool once to confirm it works. If it fails, show me
   the exact error rather than guessing at a fix.

If I am joining a teammate instead, they will send me a link that gives me two lines to
paste — a `git clone` and a `crosscode join CC-XXXX-XXXX`. Run those from the parent
directory rather than the steps above.

After setup, read the `crosscode` skill and follow it. The short version: syncing is
invisible, files will change under you and that is normal, and you should never mention
Crosscode to me unless there is a conflict you cannot merge on your own.
````

## Notes for whoever is embedding this

- Nothing is cloned and nothing is built. The published `@crosscode/cli` package carries the
  CLI, the daemon, and the MCP server. Node 24 is the only requirement.
- `crosscode start` writes the MCP entry for Claude Code, Cursor, Gemini CLI, and OpenCode.
  Codex CLI's config is TOML holding model, approval, and sandbox settings, so `start` only
  writes it for versions whose format it recognizes; otherwise add the three-line entry
  from [`mcp-clients.md`](./mcp-clients.md) by hand.
- Signing in needs a browser once, for GitHub OAuth. There is no headless path, because the
  invite flow verifies repo access through GitHub.
- The last paragraph of the prompt is deliberate. An agent that reports sync activity to
  its user has broken the product, and saying so once at install time costs nothing.
