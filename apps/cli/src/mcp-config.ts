import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { CliError } from "./errors.js";
import { isObject, readJsonObject, writeJsonObjectIfChanged, type JsonObject } from "./json-file.js";

/**
 * Writing the `crosscode` MCP server into a client's config file -- one of the three things
 * `crosscode start` installs, and the one that turns a running daemon into something an
 * agent can actually reach.
 *
 * Only clients whose config is JSON are written. Codex CLI keeps its servers in
 * `~/.codex/config.toml`, and merging TOML without a TOML parser -- into a global file
 * holding the user's model, approval, and sandbox settings -- risks corrupting settings that
 * have nothing to do with us.
 */

export type McpClient = "claude" | "cursor" | "gemini" | "opencode";

const CLIENTS: Record<McpClient, { label: string; path: string[] }> = {
  claude: { label: "Claude Code", path: [".mcp.json"] },
  cursor: { label: "Cursor", path: [".cursor", "mcp.json"] },
  gemini: { label: "Gemini CLI", path: [".gemini", "settings.json"] },
  opencode: { label: "OpenCode", path: ["opencode.json"] }
};

export const MCP_CLIENTS = Object.keys(CLIENTS) as McpClient[];

export type McpLaunch = { command: string; args: string[]; env?: Record<string, string> };
export type McpRegistration = { client: McpClient; label: string; path: string; changed: boolean };

export function parseMcpClient(value: string): McpClient {
  if (!(value in CLIENTS)) {
    throw new CliError("USAGE_ERROR", `Unknown MCP client: ${value}`, `Pass one of ${MCP_CLIENTS.join(", ")}.`);
  }
  return value as McpClient;
}

/**
 * How an MCP client should launch the server so that it still works tomorrow.
 *
 * `npx @crosscode/cli` runs out of a cache directory npm is free to evict, and the bare
 * `crosscode-mcp` only resolves while npx's own PATH is in effect -- so writing the short
 * command there produces a config that works exactly once and then fails at the next agent
 * session with a command-not-found the user cannot connect back to this. In that case the
 * npx invocation itself is written, pinned to this version, which re-resolves from the
 * registry (and its cache) on every launch. A real install -- global, or a project
 * dependency -- gets the short command.
 *
 * On Windows the entry also carries `CROSSCODE_SERVE_MCP=1`. Both published bins are the
 * same file and dispatch on the name they were invoked under (see `apps/cli/src/index.ts`),
 * and npm's Windows `.cmd` shims pass the resolved script path as argv[1] instead of the bin
 * name, leaving that dispatch nothing to read. The environment variable is the spelling that
 * works there; a `crosscode mcp` subcommand is not available, because the CLI has exactly
 * five commands.
 */
export function resolveMcpLaunch(
  version: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): McpLaunch {
  const env = platform === "win32" ? { CROSSCODE_SERVE_MCP: "1" } : undefined;
  const installed = findOnPath("crosscode-mcp", environment, platform);
  if (installed && !isEphemeral(installed, environment)) return { command: "crosscode-mcp", args: [], ...(env && { env }) };
  return { command: "npx", args: ["-y", "--package", `@crosscode/cli@${version}`, "crosscode-mcp"], ...(env && { env }) };
}

function findOnPath(name: string, environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const candidates = platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  for (const entry of (environment.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const candidate of candidates) {
      const path = join(entry, candidate);
      try {
        accessSync(path, constants.X_OK);
        return path;
      } catch {
        // Not here; keep walking PATH.
      }
    }
  }
  return undefined;
}

/**
 * npx unpacks a package into `<npm cache>/_npx/<hash>` and puts its `.bin` on PATH for the
 * duration of the run. Anything under that tree disappears the moment npm cleans its cache,
 * so it is not somewhere an MCP client config may point.
 */
function isEphemeral(binPath: string, environment: NodeJS.ProcessEnv): boolean {
  if (/[\\/]_npx[\\/]/.test(binPath)) return true;
  const cache = environment.npm_config_cache;
  return Boolean(cache && binPath.startsWith(cache));
}

/** Merges a `crosscode` entry into `client`'s config under `repoRoot`, leaving the rest alone. */
export async function registerMcpServer(repoRoot: string, client: McpClient, launch: McpLaunch): Promise<McpRegistration> {
  const spec = CLIENTS[client];
  const path = join(repoRoot, ...spec.path);
  const existing = await readJsonObject(path);
  const merged = client === "opencode" ? withOpencodeEntry(existing, launch) : withMcpServersEntry(existing, launch);
  const changed = await writeJsonObjectIfChanged(path, existing, merged);
  return { client, label: spec.label, path, changed };
}

function withMcpServersEntry(existing: JsonObject | undefined, launch: McpLaunch): JsonObject {
  const base = existing ?? {};
  const servers = isObject(base.mcpServers) ? base.mcpServers : {};
  return { ...base, mcpServers: { ...servers, crosscode: { command: launch.command, args: launch.args, ...(launch.env && { env: launch.env }) } } };
}

// OpenCode nests servers under `mcp` and takes command+args as a single array.
function withOpencodeEntry(existing: JsonObject | undefined, launch: McpLaunch): JsonObject {
  const base = existing ?? {};
  const servers = isObject(base.mcp) ? base.mcp : {};
  return {
    ...base,
    mcp: { ...servers, crosscode: { type: "local", command: [launch.command, ...launch.args], enabled: true, ...(launch.env && { environment: launch.env }) } }
  };
}
