import type { Conflict } from "@crosscode/protocol";
import type { DaemonApi } from "./daemon-api.js";
import { conflictNotice } from "./index.js";

/**
 * The pre-edit hook. MCP alone already surfaces conflicts on every tool response, which is
 * what makes every agent work; this is the bonus for the two clients that can run something
 * before a file edit. It turns "you will find out on your next tool call" into "you find out
 * before you write over it".
 *
 * Everything here degrades to silence: an unparseable payload, a payload with no file path,
 * or no reachable daemon all mean "not our business, let the edit through".
 */
export interface HookDecision {
  path: string;
  reason: string;
}

const PATH_KEYS = ["file_path", "filePath", "notebook_path", "path"];
const NESTED_KEYS = ["tool_input", "toolInput", "input", "arguments", "params"];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

/**
 * Claude Code sends `{ tool_name, tool_input: { file_path } }` on stdin. Codex's payload is
 * shaped differently and has moved between releases, so look for the path in the obvious
 * places rather than pinning one client's spelling.
 */
export function extractPath(payload: unknown): string | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  const candidates = [root, ...NESTED_KEYS.map((key) => asRecord(root[key])).filter(Boolean) as Record<string, unknown>[]];
  for (const candidate of candidates) {
    for (const key of PATH_KEYS) {
      const value = candidate[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}

/** Conflict paths are repo-relative; a hook payload's path is usually absolute. */
export function matchesPath(conflict: Conflict, path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized === conflict.path || normalized.endsWith(`/${conflict.path}`);
}

export async function runHook(api: DaemonApi, payload: unknown): Promise<HookDecision | undefined> {
  const path = extractPath(payload);
  if (!path) return undefined;

  let conflicts: Conflict[];
  try {
    conflicts = await api.conflicts();
  } catch {
    return undefined;
  }

  const matching = conflicts.filter((conflict) => matchesPath(conflict, path));
  if (matching.length === 0) return undefined;
  return {
    path,
    reason: `${conflictNotice(matching)} This file is frozen until then, so edit it after resolving, not before.`
  };
}
