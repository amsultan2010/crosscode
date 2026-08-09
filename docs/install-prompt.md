# crosscode install prompt

text to paste into a coding agent's chat when you would rather it did the setup. the agent
has shell access in the project, so it can do every step itself. this is also what the
site's "install" button copies, so keep both in sync.

## the prompt

````text
set up crosscode for this project. crosscode syncs uncommitted working-tree files between
my teammates' checkouts and mine in real time: they edit, my copy updates within seconds,
and vice versa. it never touches commits, branches, or remotes. do the following:

1. check that node 24 or newer is available (`node --version`). if it is not, stop and
   tell me, because everything below needs it.
2. from this project's git root, run:

   ```
   npm install -g crosscode-cli && crosscode start
   ```

   `start` does the whole setup: it signs me in with github, attaches this checkout to a
   project, starts the background daemon, and installs the crosscode mcp server, skill,
   and pre-edit hook for you. it is safe to re-run.
3. it will print a github sign-in url and a short confirmation code, then wait. show me
   both and stop there. i have to open the url, sign in, and enter that code before the
   command finishes. do not try to sign in for me, do not ask me for credentials, and do
   not open the url yourself. it is my browser session that has to sign in, not yours.
4. once `start` reports success, tell me i need to restart you (or reconnect mcp servers)
   for the "crosscode" server to be picked up.
5. once reconnected, call the `status` tool once to confirm it works. if it fails, show me
   the exact error rather than guessing at a fix.

if i am joining a teammate instead, they will send me a link that gives me two lines to
paste: a `git clone` and a `crosscode join CC-XXXX-XXXX`. run those from the parent
directory rather than the steps above.

after setup, read the `crosscode` skill and follow it. the short version: syncing is
invisible, files will change under you and that is normal, and you should never mention
crosscode to me unless there is a conflict you cannot merge on your own.
````

## notes for whoever is embedding this

- nothing is cloned and nothing is built. the published `crosscode-cli` package carries the
  cli, the daemon, and the mcp server. node 24 is the only requirement.
- `crosscode start` writes the mcp entry for claude code, cursor, gemini cli, and opencode.
  codex cli's config is toml holding model, approval, and sandbox settings, so `start` only
  writes it for versions whose format it recognizes; otherwise add the three-line entry
  from [`mcp-clients.md`](./mcp-clients.md) by hand.
- signing in needs a browser once, for github oauth. there is no headless path, because the
  invite flow verifies repo access through github. it is a device-code handshake (a url
  and a code the user types into the page) so the browser does not have to be on the same
  machine as the terminal, and nothing has to be pasted back.
- step 3 is the step agents get wrong. an agent that "helpfully" opens the url in its own
  tooling signs in as nobody, and the poll never completes. the prompt says so twice on
  purpose.
- the last paragraph of the prompt is deliberate. an agent that reports sync activity to
  its user has broken the product, and saying so once at install time costs nothing.
