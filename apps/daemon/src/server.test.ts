import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "./index.js";

const exec = promisify(execFile);
const directories: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

async function repo(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "crosscode-server-"));
  directories.push(path);
  await exec("git", ["init", "-q", path]);
  await exec("git", ["-C", path, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", path, "config", "user.name", "Test"]);
  await writeFile(join(path, "a.txt"), "one\n");
  await exec("git", ["-C", path, "add", "."]);
  await exec("git", ["-C", path, "commit", "-qm", "initial"]);
  return path;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local daemon HTTP boundary", () => {
  it("requires authentication and validates JSON request bodies", async () => {
    const running = await startDaemon(await repo(), { workspaceId: "w", replicaId: "r", actorId: "a" });
    servers.push(running);
    const url = `http://127.0.0.1:${running.port}`;

    const unauthenticated = await fetch(`${url}/v1/status`);
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toEqual({ ok: false, error: "Unauthorized" });

    const malformed = await fetch(`${url}/v1/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${running.secret}`, "content-type": "application/json" },
      body: "{"
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ ok: false, error: "Malformed JSON" });

    const invalid = await fetch(`${url}/v1/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${running.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "", unknown: true })
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ ok: false, error: "Invalid request" });
  });

  it("rejects unsupported content types and oversized bodies", async () => {
    const running = await startDaemon(await repo(), { workspaceId: "w", replicaId: "r", actorId: "a" });
    servers.push(running);
    const url = `http://127.0.0.1:${running.port}/v1/tasks`;
    const authorization = `Bearer ${running.secret}`;

    const unsupported = await fetch(url, { method: "POST", headers: { authorization, "content-type": "text/plain" }, body: "{}" });
    expect(unsupported.status).toBe(415);

    const oversized = await fetch(url, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ title: "x".repeat(1_048_577) })
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({ ok: false, error: "Request body too large" });
  });

  it("runs only validation commands selected from trusted local configuration", async () => {
    const root = await repo();
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, ".crosscode"), { recursive: true }));
    await writeFile(join(root, ".crosscode", "config.yaml"), "version: 1\nvalidation:\n  profiles:\n    fast:\n      commands:\n        - node -e \"process.stdout.write('configured')\"\n");
    await exec("git", ["-C", root, "add", "-f", ".crosscode/config.yaml"]);
    await exec("git", ["-C", root, "commit", "-qm", "add trusted validation config"]);
    const running = await startDaemon(root, { workspaceId: "w", replicaId: "r", actorId: "a" });
    servers.push(running);
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/validate`, {
      method: "POST",
      headers: { authorization: `Bearer ${running.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ profile: "fast" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: [{ profile: "fast", command: expect.stringContaining("process.stdout.write"), exitCode: 0, output: "configured" }] });

    const injected = await fetch(`http://127.0.0.1:${running.port}/v1/validate`, {
      method: "POST",
      headers: { authorization: `Bearer ${running.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ profile: "fast", commands: ["node -e \"throw new Error('injected')\""] })
    });
    expect(injected.status).toBe(400);
  });
});

describe("daemon failure reporting", () => {
  it("reports why a request failed instead of a bare 'Request failed'", async () => {
    const path = await repo();
    const running = await startDaemon(path, { workspaceId: "w", replicaId: "r", actorId: "a" });
    servers.push(running);

    // No committed .crosscode/config.yaml: the single most likely first-run failure.
    // It used to surface as an opaque 500 with the real cause only in the daemon's own
    // stderr, leaving a CLI or agent caller nothing to act on.
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/validate`, {
      method: "POST",
      headers: { authorization: `Bearer ${running.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ profile: "fast" })
    });
    const body = await response.json() as { ok: boolean; error: string };

    expect(body.ok).toBe(false);
    expect(body.error).not.toBe("Request failed");
    expect(body.error).toContain("fast");
    expect(body.error).toMatch(/config\.yaml/);
  });

  it("masks the repository root so absolute paths stay out of agent transcripts", async () => {
    const path = await repo();
    const running = await startDaemon(path, { workspaceId: "w", replicaId: "r", actorId: "a" });
    servers.push(running);

    const response = await fetch(`http://127.0.0.1:${running.port}/v1/checkpoints/restore`, {
      method: "POST",
      headers: { authorization: `Bearer ${running.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ ref: "refs/crosscode/checkpoints/r/does-not-exist", path: "a.txt" })
    });
    const body = await response.json() as { ok: boolean; error: string };

    expect(body.ok).toBe(false);
    expect(body.error).not.toContain(running.daemon.root);
  });
});
