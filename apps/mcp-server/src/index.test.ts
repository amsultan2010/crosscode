import { execFile } from "node:child_process";
import { mkdir, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { daemonConnectionSchema } from "@crosscode/protocol";
import { DaemonClient } from "../../daemon/src/client.js";
import { daemonConnectionPath } from "../../daemon/src/runtime.js";
import { startDaemon, type RunningDaemon } from "../../daemon/src/index.js";
import { mcpTools } from "./index.js";

const exec = promisify(execFile);
const directories: string[] = [];
const daemons: RunningDaemon[] = [];
const clients: Client[] = [];
const spawnedDaemonPids: number[] = [];

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const mcpMain = join(repoRoot, "apps/mcp-server/src/main.ts");

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  for (const pid of spawnedDaemonPids.splice(0)) { try { process.kill(pid, "SIGTERM"); } catch {} }
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crosscode-mcp-"));
  directories.push(root);
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", root, "config", "user.name", "Test"]);
  await writeFile(join(root, "a.txt"), "one\n");
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "commit", "-qm", "initial"]);
  return root;
}

async function writeConnectionFile(path: string, connection: { pid: number; port: number; secret: string; startedAt: string }): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeFile(path, JSON.stringify(daemonConnectionSchema.parse(connection)), { mode: 0o600 });
}

describe("MCP daemon boundary", () => {
  it("maps tools through the authenticated HTTP client", async () => {
    const root = await initRepo();
    const daemon = await startDaemon(root, { workspaceId: "w", replicaId: "r", actorId: "a" });
    daemons.push(daemon);
    const tools = mcpTools(DaemonClient.from({ pid: process.pid, port: daemon.port, secret: daemon.secret, startedAt: new Date().toISOString() }));

    const expectedRoot = (await exec("git", ["-C", root, "rev-parse", "--show-toplevel"])).stdout.trim();
    await expect(tools.get_workspace_state()).resolves.toMatchObject({ root: expectedRoot });
  });

  it("serves a standards-compliant MCP server over stdio: real initialize, tools/list, and tools/call", async () => {
    const root = await initRepo();
    const daemon = await startDaemon(root, { workspaceId: "w", replicaId: "r", actorId: "a" });
    daemons.push(daemon);
    const connectionPath = await daemonConnectionPath(root);
    await writeConnectionFile(connectionPath, { pid: process.pid, port: daemon.port, secret: daemon.secret, startedAt: new Date().toISOString() });

    const transport = new StdioClientTransport({ command: tsxBin, args: [mcpMain], cwd: root, stderr: "inherit" });
    const client = new Client({ name: "crosscode-mcp-test-client", version: "0.1.0" });
    clients.push(client);
    await client.connect(transport);

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name).sort();
    expect(toolNames).toEqual(["get_workspace_state"]);
    const stateTool = tools.find((tool) => tool.name === "get_workspace_state")!;
    expect(stateTool.inputSchema.type).toBe("object");

    const statusResult = await client.callTool({ name: "get_workspace_state", arguments: {} });
    const status = JSON.parse((statusResult.content as Array<{ type: string; text: string }>)[0]!.text) as { root: string };
    const expectedRoot = (await exec("git", ["-C", root, "rev-parse", "--show-toplevel"])).stdout.trim();
    expect(status.root).toBe(expectedRoot);
  }, 20_000);

  it("auto-bootstraps identity and spawns its own daemon when neither exists yet, so a fresh checkout works with zero manual setup", async () => {
    const root = await initRepo();
    const connectionPath = await daemonConnectionPath(root);
    await expect(readFile(connectionPath, "utf8")).rejects.toThrow();

    const transport = new StdioClientTransport({ command: tsxBin, args: [mcpMain], cwd: root, stderr: "inherit" });
    const client = new Client({ name: "crosscode-mcp-bootstrap-test-client", version: "0.1.0" });
    clients.push(client);
    await client.connect(transport);

    const statusResult = await client.callTool({ name: "get_workspace_state", arguments: {} });
    const status = JSON.parse((statusResult.content as Array<{ type: string; text: string }>)[0]!.text) as { root: string; branch?: string };
    const expectedRoot = (await exec("git", ["-C", root, "rev-parse", "--show-toplevel"])).stdout.trim();
    expect(status.root).toBe(expectedRoot);

    // The MCP server spawned a real, independent daemon process (not one this test started)
    // and it wrote its own connection descriptor -- confirm one now exists and track its pid
    // so it can be torn down after the test.
    const connection = daemonConnectionSchema.parse(JSON.parse(await readFile(connectionPath, "utf8")));
    expect(connection.pid).not.toBe(process.pid);
    spawnedDaemonPids.push(connection.pid);
  }, 20_000);
});
