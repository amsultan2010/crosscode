import { accessSync, constants } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { CliError } from "./errors.js";

/**
 * Writing the `crosscode` MCP server into a client's config file, which is the last step of
 * `crosscode start` and the one that turns a running daemon into something an agent can
 * actually reach.
 *
 * Only clients whose config is JSON are written. Codex CLI keeps its servers in
 * `~/.codex/config.toml`, and merging TOML without a TOML parser -- into a global file
 * holding the user's model, approval, and sandbox settings -- risks corrupting settings that
 * have nothing to do with us. Those three lines are in `docs/mcp-clients.md` instead.
 */

export type McpClient = "claude" | "cursor" | "gemini" | "opencode";

const CLIENTS: Record<McpClient, { label: string; path: string[] }> = {
  claude: { label: "Claude Code", path: [".mcp.json"] },
  cursor: { label: "Cursor", path: [".cursor", "mcp.json"] },
  gemini: { label: "Gemini CLI", path: [".gemini", "settings.json"] },
  opencode: { label: "OpenCode", path: ["opencode.json"] }
};

export const MCP_CLIENTS = Object.keys(CLIENTS) as McpClient[];

export type McpLaunch = { command: string; args: string[] };
export type McpRegistration = { client: McpClient; label: string; path: string; changed: boolean };

export function parseMcpClient(value: string): McpClient {
  if (!(value in CLIENTS)) {
    throw new CliError(
      "USAGE_ERROR",
      `Unknown MCP client: ${value}`,
      `Pass one of ${MCP_CLIENTS.join(", ")}, or --no-mcp to skip registration. Codex CLI is configured by hand -- see docs/mcp-clients.md.`
    );
  }
  return value as McpClient;
}

/**
 * How an MCP client should launch the server so that it still works tomorrow.
 *
 * `npx @crosscode/cli start` runs out of a cache directory npm is free to evict, and the
 * bare `crosscode-mcp` only resolves while npx's own PATH is in effect -- so writing the
 * short command there produces a config that works exactly once and then fails at the next
 * agent session with a command-not-found the user cannot connect back to this. In that case
 * the npx invocation itself is written, pinned to this version, which re-resolves from the
 * registry (and its cache) on every launch. A real install -- global, or a project
 * dependency -- gets the short command.
 *
 * On Windows the short command is `crosscode mcp`, not the `crosscode-mcp` bin: both
 * published bins are the same file and dispatch on the name they were invoked under (see
 * `apps/cli/src/index.ts`), and npm's Windows `.cmd` shims pass the resolved script path as
 * argv[1] instead of the bin name, leaving that dispatch nothing to read.
 */
export function resolveMcpLaunch(
  version: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): McpLaunch {
  const [name, ...rest] = platform === "win32" ? ["crosscode", "mcp"] : ["crosscode-mcp"];
  const installed = findOnPath(name!, environment, platform);
  if (installed && !isEphemeral(installed, environment)) return { command: name!, args: rest };
  return { command: "npx", args: ["-y", "--package", `@crosscode/cli@${version}`, name!, ...rest] };
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
  const changed = JSON.stringify(merged) !== JSON.stringify(existing ?? {});
  if (changed) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`);
  }
  return { client, label: spec.label, path, changed };
}

type JsonObject = Record<string, unknown>;

function withMcpServersEntry(existing: JsonObject | undefined, launch: McpLaunch): JsonObject {
  const base = existing ?? {};
  const servers = isObject(base.mcpServers) ? base.mcpServers : {};
  return { ...base, mcpServers: { ...servers, crosscode: { command: launch.command, args: launch.args } } };
}

// OpenCode nests servers under `mcp` and takes command+args as a single array.
function withOpencodeEntry(existing: JsonObject | undefined, launch: McpLaunch): JsonObject {
  const base = existing ?? {};
  const servers = isObject(base.mcp) ? base.mcp : {};
  return { ...base, mcp: { ...servers, crosscode: { type: "local", command: [launch.command, ...launch.args], enabled: true } } };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Refuses rather than overwrites: this is a file the user owns, and it may hold entries for
// servers that have nothing to do with Crosscode.
async function readJsonObject(path: string): Promise<JsonObject | undefined> {
  const contents = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (contents === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new CliError(
      "MCP_CONFIG_UNPARSEABLE",
      `${path} is not valid JSON, so the crosscode entry was not added: ${error instanceof Error ? error.message : String(error)}`,
      "Fix the file's syntax and re-run `crosscode start`, or pass --no-mcp and add the entry by hand (docs/mcp-clients.md)."
    );
  }
  if (!isObject(parsed)) {
    throw new CliError(
      "MCP_CONFIG_UNPARSEABLE",
      `${path} does not contain a JSON object, so the crosscode entry was not added`,
      "Fix the file and re-run `crosscode start`, or pass --no-mcp and add the entry by hand (docs/mcp-clients.md)."
    );
  }
  return parsed;
}
