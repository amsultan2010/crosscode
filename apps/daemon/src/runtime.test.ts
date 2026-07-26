import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient } from "./client.js";
import { daemonConnectionPath, readDaemonConfig, runDaemonProcess, type ManagedDaemon, writeDaemonConfig } from "./runtime.js";

const exec = promisify(execFile);
const directories: string[] = [];
const daemons: ManagedDaemon[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("managed daemon runtime", () => {
  it("owns one worktree, advertises authenticated readiness, and shuts down cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "crosscode-runtime-"));
    directories.push(root);
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(join(root, "a.txt"), "one\n");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "initial"]);
    const config = { workspaceId: "w", replicaId: "r", actorId: "a" };
    await writeDaemonConfig(root, config);
    await expect(readDaemonConfig(root)).resolves.toEqual(config);

    const managed = await runDaemonProcess(root, { gitPollMs: 50 });
    daemons.push(managed);
    await expect(DaemonClient.connect(root).then((client) => client.status())).resolves.toMatchObject({ workspaceId: "w", replicaId: "r" });
    await expect(runDaemonProcess(root)).rejects.toThrow("already running");

    daemons.pop();
    await managed.stop();
    await expect(access(await daemonConnectionPath(root))).rejects.toThrow();
  });
});
