import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient } from "../../daemon/src/client.js";
import { startDaemon, type RunningDaemon } from "../../daemon/src/index.js";
import { mcpTools } from "./index.js";

const exec = promisify(execFile);
const directories: string[] = [];
const daemons: RunningDaemon[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("MCP daemon boundary", () => {
  it("maps tools through the authenticated HTTP client", async () => {
    const root = await mkdtemp(join(tmpdir(), "crosscode-mcp-"));
    directories.push(root);
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(join(root, "a.txt"), "one\n");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "initial"]);
    const daemon = await startDaemon(root, { workspaceId: "w", replicaId: "r", actorId: "a" });
    daemons.push(daemon);
    const tools = mcpTools(DaemonClient.from({ pid: process.pid, port: daemon.port, secret: daemon.secret, startedAt: new Date().toISOString() }));

    const task = await tools.claim_task({ title: "Coordinate over HTTP", paths: ["a.txt"] });
    await expect(tools.list_tasks()).resolves.toContainEqual(task);
  });
});
