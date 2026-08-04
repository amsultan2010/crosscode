import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { daemonConfigPath, daemonConnectionPath, readDaemonConfig } from "../../daemon/src/runtime.js";
import { start } from "./start.js";

const exec = promisify(execFile);
const directories: string[] = [];
const startedDaemons: string[] = [];

/**
 * A checkout paired with a workspace token, which is the one setup `start` can carry all
 * the way through without a network round-trip: pairing deliberately attaches a checkout to
 * a workspace with no user account, so the sign-in and membership steps are skipped and the
 * rest -- daemon, MCP registration -- runs for real. The service URL points at a closed
 * loopback port so the daemon's sync loop fails locally instead of reaching the internet.
 */
async function pairedRepo(): Promise<string> {
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

async function pair(root: string): Promise<void> {
  const path = await daemonConfigPath(root);
  await mkdir(join(root, ".git", "crosscode"), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({
    workspaceId: "workspace-1",
    replicaId: "replica-1",
    actorId: "actor-1",
    service: { url: "http://127.0.0.1:9", workspaceToken: "ccw_test" }
  }), { mode: 0o600 });
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

  it("takes a paired checkout from nothing to a running daemon with the MCP server registered", async () => {
    const root = await pairedRepo();
    await pair(root);
    startedDaemons.push(root);

    const result = await start(root, {});

    expect(result.repoRoot).toBe(root);
    expect(result.workspaceId).toBe("workspace-1");
    expect(result.service).toMatchObject({ paired: true, signedIn: false });
    expect(result.daemon.alreadyRunning).toBe(false);
    expect(result.mcp?.path).toBe(join(root, ".mcp.json"));
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers.crosscode).toBeDefined();
  });

  it("is idempotent: a second run reuses the daemon and reports it rather than starting another", async () => {
    const root = await pairedRepo();
    await pair(root);
    startedDaemons.push(root);
    await start(root, { mcp: false });

    const second = await start(root, { mcp: false });

    expect(second.daemon.alreadyRunning).toBe(true);
  });

  it("initializes a checkout that has no configuration at all", async () => {
    const root = await pairedRepo();
    startedDaemons.push(root);

    // No credentials and no TTY: it gets as far as needing an account, having already
    // written the identity `crosscode init` would have.
    await expect(start(root, { interactive: false, mcp: false })).rejects.toMatchObject({ code: "LOGIN_NOT_INTERACTIVE" });
    expect((await readDaemonConfig(root)).workspaceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("requires both halves of the headless sign-in", async () => {
    const root = await pairedRepo();

    await expect(start(root, { email: "a@b.c", mcp: false })).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });
});
