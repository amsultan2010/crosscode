import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "./client.js";
import { daemonConfigPath, daemonConnectionPath, readDaemonConfig, redeemPairingCode, runDaemonProcess, type ManagedDaemon, writeDaemonConfig } from "./runtime.js";
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

  it("redeems a pairing code without a login and persists the returned workspace token", async () => {
    const root = await repo();
    await exec("git", ["-C", root, "remote", "add", "origin", "git@github.com:acme/widgets.git"]);
    let claimed: any;
    const { base, close } = await stubService((body) => {
      if (body.code === "AAAA-BBBB") return { status: 410, payload: { ok: false, error: "Pairing code is no longer available" } };
      claimed = body;
      return { status: 200, payload: { ok: true, data: { workspaceId: "workspace-1", replicaId: "replica-1", token: "ccw_opaque-token", projectId: null } } };
    });
    try {
      // No prior `crosscode init` and no Supabase session: the code is the credential.
      const paired = await redeemPairingCode(root, "k4t9-2wqz", { serviceUrl: base, replicaName: "laptop", actorId: "user@host" });
      expect(paired).toMatchObject({ workspaceId: "workspace-1", replicaId: "replica-1", actorId: "user@host" });
      expect(paired.service?.workspaceToken).toBe("ccw_opaque-token");
      expect(claimed).toMatchObject({ code: "K4T9-2WQZ", replicaName: "laptop", repoRemote: "git@github.com:acme/widgets.git" });
      // git resolves the tmpdir through macOS's /private symlink, so compare the basename.
      expect(claimed.repoRoot.endsWith(root.split("/").pop()!)).toBe(true);

      await expect(readDaemonConfig(root)).resolves.toMatchObject({ service: { workspaceToken: "ccw_opaque-token" } });
      await expect(redeemPairingCode(root, "AAAA-BBBB")).rejects.toThrow("no longer valid");
    } finally {
      await close();
    }
  });
});

async function stubService(handler: (body: any) => { status: number; payload: unknown }): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const { status, payload } = handler(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}
