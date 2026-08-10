import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CliError } from "./errors.js";

/**
 * Reading and merging a JSON config file the *user* owns -- an MCP client's server list,
 * Claude Code's settings. Every one of these may hold entries that have nothing to do with
 * Crosscode, so the rule throughout is merge, never overwrite, and refuse rather than
 * clobber anything unparseable.
 */

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJsonObject(path: string): Promise<JsonObject | undefined> {
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
      "CONFIG_UNPARSEABLE",
      `${path} is not valid JSON, so the crosscode entry was not added: ${error instanceof Error ? error.message : String(error)}`,
      "Fix the file's syntax and re-run `crosscode start`."
    );
  }
  if (!isObject(parsed)) {
    throw new CliError("CONFIG_UNPARSEABLE", `${path} does not contain a JSON object, so the crosscode entry was not added`, "Fix the file and re-run `crosscode start`.");
  }
  return parsed;
}

/**
 * Writes only when the merge actually changed something, and reports which. That is what
 * makes `crosscode start` idempotent at this layer: a second run rewrites nothing and says
 * so, rather than appending a duplicate entry.
 */
export async function writeJsonObjectIfChanged(path: string, existing: JsonObject | undefined, merged: JsonObject): Promise<boolean> {
  if (JSON.stringify(merged) === JSON.stringify(existing ?? {})) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(merged, null, 2)}\n`);
  return true;
}

/**
 * Writes beside the destination and renames onto it, so a run that dies partway through
 * leaves the user's file exactly as it was. `writeFile` opens the destination itself and
 * empties it before the first byte lands: interrupt that and what is left is a zero-byte
 * `.mcp.json` -- every MCP server the user had, gone, by a command that was only asked to
 * add one. The temporary sits in the same directory so the rename stays within one
 * filesystem, which is what makes it atomic.
 */
export async function writeFileAtomic(path: string, contents: string, mode?: number): Promise<void> {
  const temporary = `${path}.crosscode-${process.pid}.tmp`;
  try {
    await writeFile(temporary, contents, mode === undefined ? undefined : { mode });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
