import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { configuredAiReviewPolicy, configuredAutoApplyRisk, configuredExcludedPaths, validationCommands } from "./config.js";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A repository whose HEAD commit contains the given `.crosscode/config.yaml`, or none. */
async function repoWithConfig(yaml?: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "crosscode-config-"));
  directories.push(path);
  await exec("git", ["init", "-q", "-b", "main", path]);
  await exec("git", ["-C", path, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", path, "config", "user.name", "Test"]);
  await writeFile(join(path, "a.txt"), "one\n");
  if (yaml !== undefined) {
    await mkdir(join(path, ".crosscode"), { recursive: true });
    await writeFile(join(path, ".crosscode", "config.yaml"), yaml);
  }
  await exec("git", ["-C", path, "add", "-A"]);
  await exec("git", ["-C", path, "commit", "-qm", "initial"]);
  return path;
}

/**
 * `validation` is optional. It used to be required, so a config that only set
 * excludedPaths threw out of the shared parser -- and eligiblePath() calls that parser on
 * nearly every operation, which meant a partial config took the whole daemon down rather
 * than degrading.
 */
describe("partial workspace configuration", () => {
  it("reads excludedPaths from a config with no validation block", async () => {
    const root = await repoWithConfig("version: 1\nexcludedPaths:\n  - secrets/**\n");
    expect(await configuredExcludedPaths(root)).toEqual(["secrets/**"]);
  });

  it("reads an aiReview policy from a config with no validation block", async () => {
    const root = await repoWithConfig("version: 1\naiReview:\n  externalAiReview: approved\n  allowedProviders:\n    - agent-delegated\n");
    const policy = await configuredAiReviewPolicy(root);
    expect(policy.externalAiReview).toBe("approved");
    expect(policy.allowedProviders).toEqual(["agent-delegated"]);
  });

  it("reads an autoApplyRisk policy from a config with no validation block", async () => {
    const root = await repoWithConfig("version: 1\npolicy:\n  autoApplyRisk: medium\n");
    expect(await configuredAutoApplyRisk(root)).toBe("medium");
  });

  it("still returns the unconfigured defaults when there is no config at all", async () => {
    const root = await repoWithConfig();
    expect(await configuredExcludedPaths(root)).toEqual([]);
    expect(await configuredAutoApplyRisk(root)).toBeUndefined();
    expect((await configuredAiReviewPolicy(root)).externalAiReview).toBe("disabled");
  });
});

describe("validation profile errors", () => {
  it("says there is no config, rather than surfacing a raw git failure", async () => {
    const root = await repoWithConfig();
    await expect(validationCommands(root, "fast")).rejects.toThrow(/No committed .crosscode\/config\.yaml/);
    await expect(validationCommands(root, "fast")).rejects.toThrow(/"fast"/);
  });

  it("names the profiles that do exist when the requested one does not", async () => {
    const root = await repoWithConfig("version: 1\nvalidation:\n  profiles:\n    slow:\n      commands:\n        - echo slow\n");
    await expect(validationCommands(root, "fast")).rejects.toThrow(/available: slow/);
  });

  it("says so plainly when a config exists but defines no profiles at all", async () => {
    const root = await repoWithConfig("version: 1\nexcludedPaths:\n  - secrets/**\n");
    await expect(validationCommands(root, "fast")).rejects.toThrow(/no validation\.profiles are defined/);
  });

  it("still returns a configured profile's commands", async () => {
    const root = await repoWithConfig("version: 1\nvalidation:\n  profiles:\n    fast:\n      commands:\n        - echo ok\n");
    expect(await validationCommands(root, "fast")).toEqual(["echo ok"]);
  });
});
