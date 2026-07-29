import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { minimatch } from "minimatch";
import { z } from "zod";
import { parse } from "yaml";

const exec = promisify(execFile);
const workspaceConfigSchema = z.object({
  version: z.literal(1),
  validation: z.object({
    profiles: z.record(z.object({
      commands: z.array(z.string().trim().min(1).max(10_000)).min(1).max(100)
    }).strict())
  }).strict(),
  excludedPaths: z.array(z.string().min(1).max(2_000)).max(1_000).optional(),
  aiReview: z.object({
    externalAiReview: z.enum(["disabled", "approved"]).default("disabled"),
    allowedProviders: z.array(z.string().min(1)).max(50).default([]),
    requireLocalConfirmation: z.boolean().default(true)
  }).strict().optional()
}).passthrough();

async function committedConfig(root: string): Promise<z.infer<typeof workspaceConfigSchema>> {
  const { stdout } = await exec("git", ["-C", root, "show", "HEAD:.crosscode/config.yaml"]);
  return workspaceConfigSchema.parse(parse(stdout));
}

export async function validationCommands(root: string, profile: string): Promise<string[]> {
  const config = await committedConfig(root);
  const selected = config.validation.profiles[profile];
  if (!selected) throw new Error(`Validation profile was not found: ${profile}`);
  return [...selected.commands];
}

export async function configuredExcludedPaths(root: string): Promise<string[]> {
  const exists = await exec("git", ["-C", root, "cat-file", "-e", "HEAD:.crosscode/config.yaml"]).then(() => true).catch(() => false);
  if (!exists) return [];
  const config = await committedConfig(root);
  return [...(config.excludedPaths ?? [])];
}

export function matchesConfiguredExclusion(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(path, pattern, { dot: true, matchBase: false }));
}

export type AiReviewPolicy = { externalAiReview: "disabled" | "approved"; allowedProviders: string[]; requireLocalConfirmation: boolean };
const defaultAiReviewPolicy: AiReviewPolicy = { externalAiReview: "disabled", allowedProviders: [], requireLocalConfirmation: true };

export async function configuredAiReviewPolicy(root: string): Promise<AiReviewPolicy> {
  const exists = await exec("git", ["-C", root, "cat-file", "-e", "HEAD:.crosscode/config.yaml"]).then(() => true).catch(() => false);
  if (!exists) return defaultAiReviewPolicy;
  const config = await committedConfig(root);
  return config.aiReview ?? defaultAiReviewPolicy;
}
