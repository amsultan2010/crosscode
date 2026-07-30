import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "./client.js";
import { daemonConfigPath, daemonConnectionPath, readDaemonConfig, runDaemonProcess, type ManagedDaemon, writeDaemonConfig } from "./runtime.js";
import { keychainAvailable } from "./keychain.js";

const exec = promisify(execFile);
const directories: string[] = [];
const daemons: ManagedDaemon[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crosscode-runtime-"));
  directories.push(root);
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", root, "config", "user.name", "Test"]);
  await writeFile(join(root, "a.txt"), "one\n");
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "commit", "-qm", "initial"]);
  return root;
}

describe("managed daemon runtime", () => {
  it("owns one worktree, advertises authenticated readiness, and shuts down cleanly", async () => {
    const root = await repo();
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

  it("stores a replica secret in the OS keychain instead of the config file when the keychain is available", async () => {
    if (!(await keychainAvailable())) return;
    const root = await repo();
    const config = { workspaceId: "w", replicaId: "r", actorId: "a", service: { url: "http://127.0.0.1:8788", replicaSecret: "super-secret-value" } };
    await writeDaemonConfig(root, config);

    const onDisk = JSON.parse(await readFile(await daemonConfigPath(root), "utf8"));
    expect(onDisk.service.replicaSecret).toBeUndefined();

    await expect(readDaemonConfig(root)).resolves.toEqual(config);
  });

  it("falls back to writing the secret inline in the config file when the keychain is unavailable", async () => {
    const root = await repo();
    const config = { workspaceId: "w", replicaId: "r", actorId: "a", service: { url: "http://127.0.0.1:8788", replicaSecret: "super-secret-value" } };
    const keychain = await import("./keychain.js");
    const unavailable = vi.spyOn(keychain, "keychainAvailable").mockResolvedValue(false);
    try {
      await writeDaemonConfig(root, config);
    } finally {
      unavailable.mockRestore();
    }

    const onDisk = JSON.parse(await readFile(await daemonConfigPath(root), "utf8"));
    expect(onDisk.service.replicaSecret).toBe("super-secret-value");
    await expect(readDaemonConfig(root)).resolves.toEqual(config);
  });
});
