import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { daemonConnectionPath, readDaemonConfig } from "../../daemon/src/runtime.js";
import { start } from "./start.js";

const exec = promisify(execFile);
const directories: string[] = [];
const startedDaemons: string[] = [];

async function repo(): Promise<string> {
  // realpath: on macOS the temp directory is a symlink, and Git reports the resolved path,
  // which is what `start` echoes back as repoRoot.
  const root = await realpath(await mkdtemp(join(tmpdir(), "crosscode-start-")));
  directories.push(root);
  await exec("git", ["init", "-q", "-b", "main", root]);
  await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", root, "config", "user.name", "Test"]);
  await writeFile(join(root, "a.txt"), "one\n");
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "commit", "-qm", "initial"]);
  return root;
}

async function stopDaemon(root: string): Promise<void> {
  const connection = await readFile(await daemonConnectionPath(root), "utf8").then(JSON.parse).catch(() => undefined);
  if (connection?.pid) {
    try { process.kill(connection.pid, "SIGTERM"); } catch { /* already gone */ }
  }
}

afterEach(async () => {
  await Promise.all(startedDaemons.splice(0).map(stopDaemon));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("crosscode start", () => {
  it("refuses to run outside a Git repository, since there is no checkout to coordinate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crosscode-start-bare-"));
    directories.push(directory);

    await expect(start(directory, { mcp: false })).rejects.toMatchObject({ code: "NOT_A_GIT_REPOSITORY" });
  });

  it("initializes a checkout that has no configuration at all", async () => {
    const root = await repo();
    startedDaemons.push(root);

    // No credentials and no TTY: it gets as far as needing an account, having already
    // written the identity `crosscode init` would have.
    await expect(start(root, { interactive: false, mcp: false })).rejects.toMatchObject({ code: "LOGIN_NOT_INTERACTIVE" });
    expect((await readDaemonConfig(root)).workspaceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("requires both halves of the headless sign-in", async () => {
    const root = await repo();

    await expect(start(root, { email: "a@b.c", mcp: false })).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });
});
