import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isObject, readJsonObject, writeJsonObjectIfChanged } from "./json-file.js";
import { registerMcpServer, resolveMcpLaunch, type McpClient } from "./mcp-config.js";
import { VERSION } from "./version.js";

/**
 * The three things `crosscode start` installs so that the user's own agent can see what the
 * daemon is doing: the MCP server, the skill that tells the agent what to do about a
 * conflict, and a hook that fires before file edits.
 *
 * All three are file merges, and all three report whether they changed anything -- installing
 * twice writes nothing the second time, which is most of what makes `start` idempotent.
 *
 * The *content* of the skill and the hook belongs to the agent-surface workstream. What is
 * here is the shortest honest version of each, installed in the right place.
 */

export type InstalledPiece = { path: string; changed: boolean };
export type AgentSurface = { mcp: InstalledPiece & { client: McpClient; command: string }; skill: InstalledPiece; hooks: InstalledPiece };

export async function installAgentSurface(repoRoot: string, client: McpClient = "claude"): Promise<AgentSurface> {
  const launch = resolveMcpLaunch(VERSION);
  const registration = await registerMcpServer(repoRoot, client, launch);
  return {
    mcp: { path: registration.path, changed: registration.changed, client: registration.client, command: [launch.command, ...launch.args].join(" ") },
    skill: await installSkill(repoRoot),
    hooks: await installHooks(repoRoot)
  };
}

const SKILL = `---
name: crosscode
description: What Crosscode is doing in the background, and what to do when it surfaces a conflict.
---

# Crosscode

Crosscode syncs this checkout's uncommitted working-tree files with your teammates in real
time. It runs in the background. Most of the time there is nothing to do and nothing to say.

## What is happening without you

- A teammate edits a file you have not touched: it is written to your disk, silently.
- A teammate edits different lines of a file you have touched: it is merged, silently.
- You and a teammate edit the *same lines*: that is a conflict, and it comes to you.

Do not mention Crosscode, describe the sync, or report that files changed. The user did not
ask for a sync narration.

## When there is a conflict

Every Crosscode MCP response carries the pending conflicts. When one appears:

1. Read \`ours\`, \`theirs\`, and \`ancestor\` from the conflict.
2. Merge them the way the code means to be merged -- this is your job, not Crosscode's.
   Crosscode never judges, classifies, or reviews the change.
3. Call \`resolve\` with the merged content.

The conflicted file is quarantined until you do: it is neither published nor overwritten.

## When to do nothing

- No conflicts: say nothing.
- A file changed under you mid-task: re-read it and carry on.
- The user is mid-rebase, mid-merge, or mid-bisect: sync is paused. Nothing to do.
`;

/**
 * Claude Code reads skills from `.claude/skills/<name>/SKILL.md`. Written into the repo, not
 * the home directory: the skill describes this checkout being synced, and a user who has
 * Crosscode on one project should not get it on all of them.
 */
async function installSkill(repoRoot: string): Promise<InstalledPiece> {
  const path = join(repoRoot, ".claude", "skills", "crosscode", "SKILL.md");
  const existing = await readFile(path, "utf8").catch(() => undefined);
  if (existing === SKILL) return { path, changed: false };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, SKILL);
  return { path, changed: true };
}

// `crosscode-mcp hook` -- the second entrypoint of the MCP bundle, which reads the tool
// payload on stdin and exits 2 on a conflicted path. Not `crosscode status`: that ignores
// stdin, so it never learns which file is about to be edited.
const HOOK_COMMAND = "crosscode-mcp hook";
const HOOK_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";

/**
 * A PreToolUse hook so the agent sees a pending conflict *before* it edits the file, rather
 * than after it has written over one side of it.
 *
 * Idempotent by command, not by position: the matcher entry is only appended when no hook in
 * it already runs a `crosscode` command, so a second `crosscode start` -- or a user who moved
 * the entry -- does not end up with the hook installed twice. An existing crosscode hook is
 * rewritten in place rather than left alone, because 0.1.0 installed one that pointed at the
 * wrong command and an upgrade has to repair it.
 */
async function installHooks(repoRoot: string): Promise<InstalledPiece> {
  const path = join(repoRoot, ".claude", "settings.json");
  const existing = await readJsonObject(path);
  const base = existing ?? {};
  const hooks = isObject(base.hooks) ? base.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const repaired = preToolUse.map(withCurrentCommand);
  const merged = {
    ...base,
    hooks: {
      ...hooks,
      PreToolUse: repaired.some(mentionsCrosscode) ? repaired : [...repaired, { matcher: HOOK_MATCHER, hooks: [{ type: "command", command: HOOK_COMMAND }] }]
    }
  };
  return { path, changed: await writeJsonObjectIfChanged(path, existing, merged) };
}

function mentionsCrosscode(entry: unknown): boolean {
  if (!isObject(entry) || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((hook) => isObject(hook) && typeof hook.command === "string" && hook.command.includes("crosscode"));
}

/** Points an entry's crosscode hooks at the current command, leaving everything else as it is. */
function withCurrentCommand(entry: unknown): unknown {
  if (!mentionsCrosscode(entry) || !isObject(entry) || !Array.isArray(entry.hooks)) return entry;
  return {
    ...entry,
    hooks: entry.hooks.map((hook) => (isObject(hook) && typeof hook.command === "string" && hook.command.includes("crosscode") ? { ...hook, command: HOOK_COMMAND } : hook))
  };
}
