import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonConfigPath, readDaemonConfig, writeDaemonConfig } from "./runtime.js";
import { keychainAvailable } from "./keychain.js";

const exec = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
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

describe("daemon configuration", () => {
  it("stores a Supabase refresh token in the OS keychain instead of the config file when the keychain is available", async () => {
    if (!(await keychainAvailable())) return;
    const root = await repo();
    const session = { accessToken: "access-token", refreshToken: "super-secret-refresh-token", expiresAt: "2026-01-01T00:05:00.000Z" };
    const config = { workspaceId: "w", replicaId: "r", actorId: "a", service: { url: "http://127.0.0.1:8788", session } };
    await writeDaemonConfig(root, config);

    const onDisk = JSON.parse(await readFile(await daemonConfigPath(root), "utf8"));
    expect(onDisk.service.session.refreshToken).not.toBe(session.refreshToken);

    await expect(readDaemonConfig(root)).resolves.toEqual(config);
  });

  it("falls back to writing the session inline in the config file when the keychain is unavailable", async () => {
    const root = await repo();
    const session = { accessToken: "access-token", refreshToken: "super-secret-refresh-token", expiresAt: "2026-01-01T00:05:00.000Z" };
    const config = { workspaceId: "w", replicaId: "r", actorId: "a", service: { url: "http://127.0.0.1:8788", session } };
    const keychain = await import("./keychain.js");
    const unavailable = vi.spyOn(keychain, "keychainAvailable").mockResolvedValue(false);
    try {
      await writeDaemonConfig(root, config);
    } finally {
      unavailable.mockRestore();
    }

    const onDisk = JSON.parse(await readFile(await daemonConfigPath(root), "utf8"));
    expect(onDisk.service.session.refreshToken).toBe(session.refreshToken);
    await expect(readDaemonConfig(root)).resolves.toEqual(config);
  });
});
