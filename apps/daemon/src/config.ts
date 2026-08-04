import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { minimatch } from "minimatch";
import { z } from "zod";
import { parse } from "yaml";

const exec = promisify(execFile);
// `validation` is optional: excludedPaths, aiReview, and policy are each independently
// useful, and requiring a validation block to use any of them meant a config with only
// `excludedPaths` threw out of committedConfig() -- which eligiblePath() calls on nearly
// every operation, so a partial config bricked the daemon rather than degrading.
const workspaceConfigSchema = z.object({
  version: z.literal(1),
  validation: z.object({
    profiles: z.record(z.object({
      commands: z.array(z.string().trim().min(1).max(10_000)).min(1).max(100)
    }).strict())
  }).strict().optional(),
  excludedPaths: z.array(z.string().min(1).max(2_000)).max(1_000).optional(),
  aiReview: z.object({
    externalAiReview: z.enum(["disabled", "approved"]).default("disabled"),
    allowedProviders: z.array(z.string().min(1)).max(50).default([]),
    requireLocalConfirmation: z.boolean().default(true)
  }).strict().optional(),
  policy: z.object({
    autoApplyRisk: z.enum(["low", "medium", "high", "critical"]).default("low")
  }).strict().optional()
}).passthrough();

async function committedConfig(root: string): Promise<z.infer<typeof workspaceConfigSchema>> {
  const { stdout } = await exec("git", ["-C", root, "show", "HEAD:.crosscode/config.yaml"]);
  return workspaceConfigSchema.parse(parse(stdout));
}

/** Whether a committed config exists at all; absence is the normal, unconfigured case. */
async function configExists(root: string): Promise<boolean> {
  return exec("git", ["-C", root, "cat-file", "-e", "HEAD:.crosscode/config.yaml"]).then(() => true).catch(() => false);
}

export async function validationCommands(root: string, profile: string): Promise<string[]> {
  // Distinguishing "no config" from "config without this profile" matters: the first is
  // the ordinary state of a repository that has never been set up, and reporting it as a
  // raw `git show` failure told the caller nothing about what to do next.
  if (!(await configExists(root))) {
    throw new Error(`No committed .crosscode/config.yaml, so validation profile "${profile}" is not defined. Add one with a validation.profiles.${profile}.commands list and commit it.`);
  }
  const config = await committedConfig(root);
  const selected = config.validation?.profiles[profile];
  if (!selected) {
    const available = Object.keys(config.validation?.profiles ?? {});
    throw new Error(`Validation profile was not found: ${profile}${available.length ? ` (available: ${available.join(", ")})` : " (no validation.profiles are defined in .crosscode/config.yaml)"}`);
  }
  return [...selected.commands];
}

export async function configuredExcludedPaths(root: string): Promise<string[]> {
  if (!(await configExists(root))) return [];
  const config = await committedConfig(root);
  return [...(config.excludedPaths ?? [])];
}

export function matchesConfiguredExclusion(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(path, pattern, { dot: true, matchBase: false }));
}

export type AiReviewPolicy = { externalAiReview: "disabled" | "approved"; allowedProviders: string[]; requireLocalConfirmation: boolean };
const defaultAiReviewPolicy: AiReviewPolicy = { externalAiReview: "disabled", allowedProviders: [], requireLocalConfirmation: true };

export async function configuredAiReviewPolicy(root: string): Promise<AiReviewPolicy> {
  if (!(await configExists(root))) return defaultAiReviewPolicy;
  const config = await committedConfig(root);
  return config.aiReview ?? defaultAiReviewPolicy;
}

/**
 * Returns undefined when no committed `policy` block exists, distinct from an
 * explicitly configured value -- absence must leave auto-apply fully disabled
 * (today's always-explicit-accept behavior), not silently default to "low".
 */
export async function configuredAutoApplyRisk(root: string): Promise<"low" | "medium" | "high" | "critical" | undefined> {
  if (!(await configExists(root))) return undefined;
  const config = await committedConfig(root);
  return config.policy?.autoApplyRisk;
}
