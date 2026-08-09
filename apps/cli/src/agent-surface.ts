import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isObject, readJsonObject, writeJsonObjectIfChanged } from "./json-file.js";
import { registerMcpServer, resolveMcpLaunch, type McpClient } from "./mcp-config.js";
import { SKILL_MARKDOWN } from "./skill-text.js";
import { VERSION } from "./version.js";

/**
 * The four things `crosscode start` installs so that the user's own agent can see what the
 * daemon is doing: the MCP server, the skill that tells the agent what to do about a
 * conflict, an AGENTS.md block saying the same thing for every agent that does not read
 * Claude Code skills, and a hook that fires before file edits.
 *
 * All four are file merges, and all four report whether they changed anything -- installing
 * twice writes nothing the second time, which is most of what makes `start` idempotent.
 *
 * The skill's *wording* lives in `skills/crosscode/SKILL.md` and reaches this module through
 * the generated `skill-text.ts`, so what is installed and what the repository documents cannot
 * drift apart.
 */

export type InstalledPiece = { path: string; changed: boolean };
export type AgentSurface = {
  mcp: InstalledPiece & { client: McpClient; command: string };
  skill: InstalledPiece;
  agents: InstalledPiece;
  hooks: InstalledPiece;
};

export async function installAgentSurface(repoRoot: string, client: McpClient = "claude"): Promise<AgentSurface> {
  const launch = resolveMcpLaunch(VERSION);
  const registration = await registerMcpServer(repoRoot, client, launch);
  return {
    mcp: { path: registration.path, changed: registration.changed, client: registration.client, command: [launch.command, ...launch.args].join(" ") },
    skill: await installSkill(repoRoot),
    agents: await installAgentsMd(repoRoot),
    hooks: await installHooks(repoRoot)
  };
}

/**
 * Claude Code reads skills from `.claude/skills/<name>/SKILL.md`. Written into the repo, not
 * the home directory: the skill describes this checkout being synced, and a user who has
 * Crosscode on one project should not get it on all of them.
 */
async function installSkill(repoRoot: string): Promise<InstalledPiece> {
  const path = join(repoRoot, ".claude", "skills", "crosscode", "SKILL.md");
  const existing = await readFile(path, "utf8").catch(() => undefined);
  if (existing === SKILL_MARKDOWN) return { path, changed: false };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, SKILL_MARKDOWN);
  return { path, changed: true };
}

const AGENTS_START = "<!-- crosscode:start -->";
const AGENTS_END = "<!-- crosscode:end -->";

/**
 * The same guidance for every agent that is not Claude Code. Codex, Cursor, Gemini CLI, and
 * OpenCode all read `AGENTS.md` at the repository root and none of them read a Claude Code
 * skill, so without this the MCP server is installed for them with nothing telling them what
 * a conflict means.
 *
 * The file belongs to the user, so the crosscode block is fenced by HTML comments and only
 * what is between them is ever rewritten: an upgrade replaces the block in place, and
 * everything the user wrote around it survives byte for byte.
 */
async function installAgentsMd(repoRoot: string): Promise<InstalledPiece> {
  const path = join(repoRoot, "AGENTS.md");
  const existing = await readFile(path, "utf8").catch(() => undefined);
  const block = `${AGENTS_START}\n${withoutFrontmatter(SKILL_MARKDOWN)}${AGENTS_END}\n`;
  const merged = existing === undefined ? block : withBlock(existing, block);
  if (existing === merged) return { path, changed: false };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, merged);
  return { path, changed: true };
}

function withBlock(existing: string, block: string): string {
  const start = existing.indexOf(AGENTS_START);
  const end = existing.indexOf(AGENTS_END);
  if (start === -1 || end < start) return `${existing.replace(/\n*$/, "")}\n\n${block}`;
  return existing.slice(0, start) + block + existing.slice(end + AGENTS_END.length).replace(/^\n/, "");
}

/**
 * The `---`-fenced YAML header a skill file carries and AGENTS.md has no use for. Only a
 * header at the very top counts; a `---` rule further down the document is left alone.
 */
function withoutFrontmatter(markdown: string): string {
  const match = /^---\n[\s\S]*?\n---\n/.exec(markdown);
  return match ? markdown.slice(match[0].length).replace(/^\n+/, "") : markdown;
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
