import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { configuredExcludedPaths } from "./config.js";

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

describe("workspace configuration", () => {
  it("reads excludedPaths from a committed config", async () => {
    const root = await repoWithConfig("version: 1\nexcludedPaths:\n  - secrets/**\n");
    expect(await configuredExcludedPaths(root)).toEqual(["secrets/**"]);
  });

  it("still returns the unconfigured defaults when there is no config at all", async () => {
    const root = await repoWithConfig();
    expect(await configuredExcludedPaths(root)).toEqual([]);
  });
});
