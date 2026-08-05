import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { minimatch } from "minimatch";
import { z } from "zod";
import { parse } from "yaml";

const exec = promisify(execFile);
const workspaceConfigSchema = z.object({
  version: z.literal(1),
  excludedPaths: z.array(z.string().min(1).max(2_000)).max(1_000).optional()
}).passthrough();

async function committedConfig(root: string): Promise<z.infer<typeof workspaceConfigSchema>> {
  const { stdout } = await exec("git", ["-C", root, "show", "HEAD:.crosscode/config.yaml"]);
  return workspaceConfigSchema.parse(parse(stdout));
}

/** Whether a committed config exists at all; absence is the normal, unconfigured case. */
async function configExists(root: string): Promise<boolean> {
  return exec("git", ["-C", root, "cat-file", "-e", "HEAD:.crosscode/config.yaml"]).then(() => true).catch(() => false);
}

export async function configuredExcludedPaths(root: string): Promise<string[]> {
  if (!(await configExists(root))) return [];
  const config = await committedConfig(root);
  return [...(config.excludedPaths ?? [])];
}

export function matchesConfiguredExclusion(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(path, pattern, { dot: true, matchBase: false }));
}
