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
import { AgentDelegatedReviewer, contentHash } from "@crosscode/core";
import { DaemonClient } from "../../daemon/src/client.js";
import { daemonConnectionPath } from "../../daemon/src/runtime.js";
import { startDaemon, LocalDaemon, type RunningDaemon } from "../../daemon/src/index.js";
import { CoordinationService } from "../../service/src/index.js";
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

async function initReviewRepo(): Promise<string> {
  const root = await initRepo();
  await mkdir(join(root, ".crosscode"), { recursive: true });
  await writeFile(join(root, ".crosscode", "config.yaml"),
    "version: 1\nvalidation:\n  profiles:\n    fast:\n      commands:\n        - node --version\naiReview:\n  externalAiReview: approved\n  allowedProviders:\n    - mock-provider\n  requireLocalConfirmation: true\n");
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "commit", "-qm", "ai review policy"]);
  return root;
}

async function likelyCompatibleProposal(senderRoot: string, receiverRoot: string, service: CoordinationService, receiver: LocalDaemon) {
  const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" });
  await writeFile(join(senderRoot, "a.txt"), "sender-edit\n");
  const operation = await sender.capture("edit", service);
  await receiver.sync(service);
  const modifyChange = { path: "a.txt", kind: "modify" as const, beforeHash: contentHash("one\n"), afterHash: contentHash("receiver-edit\n"), afterContent: "receiver-edit\n" };
  const pendingLocal = { id: "fake-local-op", workspaceId: "w", senderReplicaId: "receiver", transaction: { id: "fake-local-op", base: { files: [] }, changes: [modifyChange], provenance: { source: "filesystem" as const, confidence: "known" as const }, safety: { risk: "low" as const, requiresApproval: false } }, sequence: 1, createdAt: new Date().toISOString(), status: "local" as const };
  receiver.operations.set(pendingLocal.id, pendingLocal);
  return operation;
}

describe("MCP daemon boundary", () => {
  it("maps tools through the authenticated HTTP client", async () => {
    const root = await initRepo();
    const daemon = await startDaemon(root, { workspaceId: "w", replicaId: "r", actorId: "a" });
    daemons.push(daemon);
    const tools = mcpTools(DaemonClient.from({ pid: process.pid, port: daemon.port, secret: daemon.secret, startedAt: new Date().toISOString() }));

    const task = await tools.claim_task({ title: "Coordinate over HTTP", paths: ["a.txt"] });
    await expect(tools.list_tasks()).resolves.toContainEqual(task);
  });

  it("tags submit_change_summary and announce_interface_change transactions with a kind discriminator", async () => {
    const root = await initRepo();
    const daemon = await startDaemon(root, { workspaceId: "w", replicaId: "r", actorId: "a" });
    daemons.push(daemon);
    const client = DaemonClient.from({ pid: process.pid, port: daemon.port, secret: daemon.secret, startedAt: new Date().toISOString() });
    const tools = mcpTools(client);

    await writeFile(join(root, "a.txt"), "summary edit\n");
    const summary = await tools.submit_change_summary({ summary: "Renamed the checkout handler" });
    expect(summary.transaction.kind).toBe("summary");

    await writeFile(join(root, "a.txt"), "interface edit\n");
    const interfaceChange = await tools.announce_interface_change({ intent: "Added paymentStatus to CheckoutResponse" });
    expect(interfaceChange.transaction.kind).toBe("interface-change");

    await writeFile(join(root, "a.txt"), "plain edit\n");
    const intent = await tools.publish_intent({ intent: "Plain edit" });
    expect(intent.transaction.kind).toBe("intent");
  });

  it("flags overlapping paths through check_change_scope using claims and pending proposals", async () => {
    const root = await initRepo();
    const daemon = await startDaemon(root, { workspaceId: "w", replicaId: "r", actorId: "a" });
    daemons.push(daemon);
    const client = DaemonClient.from({ pid: process.pid, port: daemon.port, secret: daemon.secret, startedAt: new Date().toISOString() });
    const tools = mcpTools(client);

    const task = await tools.claim_task({ title: "Refactor checkout" });
    await tools.claim_scope({ taskId: task.id, target: "src/checkout" });

    const clear = await tools.check_change_scope({ paths: ["src/unrelated.ts"] });
    expect(clear).toEqual({ clear: true, overlaps: [] });

    const overlapping = await tools.check_change_scope({ paths: ["src/checkout/handler.ts"] });
    expect(overlapping.clear).toBe(false);
    expect(overlapping.overlaps).toContainEqual({ path: "src/checkout/handler.ts", with: "claim", target: "src/checkout", ownerId: "a" });
  });

  it("makes a real daemon call for request_handoff instead of echoing a fake response", async () => {
    const root = await initRepo();
    const daemon = await startDaemon(root, { workspaceId: "w", replicaId: "r", actorId: "a" });
    daemons.push(daemon);
    const client = DaemonClient.from({ pid: process.pid, port: daemon.port, secret: daemon.secret, startedAt: new Date().toISOString() });
    const tools = mcpTools(client);

    await writeFile(join(root, "a.txt"), "handoff edit\n");
    const operation = await tools.publish_intent({ intent: "Change worth handing off" });

    const handoff = await tools.request_handoff({ operationId: operation.id, note: "Please review" });
    expect(handoff.status).toBe("pending");
    expect(handoff.operationId).toBe(operation.id);

    const accepted = await client.respondHandoff(handoff.id, "accepted");
    expect(accepted.status).toBe("accepted");
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
    expect(toolNames).toEqual([
      "accept_proposal",
      "announce_interface_change",
      "check_change_scope",
      "claim_scope",
      "claim_task",
      "create_checkpoint",
      "diff_proposal",
      "get_workspace_state",
      "inspect_proposal",
      "list_pending_semantic_reviews",
      "list_proposal_artifacts",
      "list_remote_proposals",
      "list_tasks",
      "publish_branch",
      "publish_intent",
      "reject_proposal",
      "request_handoff",
      "request_validation",
      "submit_change_summary",
      "submit_semantic_review"
    ]);
    const claimTaskTool = tools.find((tool) => tool.name === "claim_task")!;
    expect(claimTaskTool.inputSchema.type).toBe("object");
    expect(claimTaskTool.inputSchema.properties).toHaveProperty("title");

    const createdTask = await client.callTool({ name: "claim_task", arguments: { title: "Coordinate through MCP", paths: ["a.txt"] } });
    const task = JSON.parse((createdTask.content as Array<{ type: string; text: string }>)[0]!.text) as { id: string; title: string };
    expect(task.title).toBe("Coordinate through MCP");

    const listed = await client.callTool({ name: "list_tasks", arguments: {} });
    const tasks = JSON.parse((listed.content as Array<{ type: string; text: string }>)[0]!.text) as Array<{ id: string }>;
    expect(tasks.map((entry) => entry.id)).toContain(task.id);
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

    const createdTask = await client.callTool({ name: "claim_task", arguments: { title: "Works without any manual init or daemon start" } });
    const task = JSON.parse((createdTask.content as Array<{ type: string; text: string }>)[0]!.text) as { id: string; title: string };
    expect(task.title).toBe("Works without any manual init or daemon start");
  }, 20_000);

  it("lets the connected agent discover and resolve a pending semantic review over MCP", async () => {
    const senderRoot = await initReviewRepo();
    const receiverRoot = await initReviewRepo();
    const service = new CoordinationService();
    const running = await startDaemon(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b", reviewer: new AgentDelegatedReviewer() });
    daemons.push(running);
    const operation = await likelyCompatibleProposal(senderRoot, receiverRoot, service, running.daemon);
    const connectionPath = await daemonConnectionPath(receiverRoot);
    await writeConnectionFile(connectionPath, { pid: process.pid, port: running.port, secret: running.secret, startedAt: new Date().toISOString() });

    const transport = new StdioClientTransport({ command: tsxBin, args: [mcpMain], cwd: receiverRoot, stderr: "inherit" });
    const client = new Client({ name: "crosscode-mcp-semantic-review-test-client", version: "0.1.0" });
    clients.push(client);
    await client.connect(transport);

    const reviewPromise = fetch(`http://127.0.0.1:${running.port}/v1/operations/${operation.id}/reviews`, {
      method: "POST",
      headers: { authorization: `Bearer ${running.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ path: "a.txt", providerId: "mock-provider" })
    });

    let pending: Array<{ requestId: string; requestedAt: string; request: { workspaceId: string } }> = [];
    for (let attempt = 0; attempt < 50 && pending.length === 0; attempt += 1) {
      const listed = await client.callTool({ name: "list_pending_semantic_reviews", arguments: {} });
      pending = JSON.parse((listed.content as Array<{ type: string; text: string }>)[0]!.text);
      if (pending.length === 0) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    expect(pending).toHaveLength(1);
    expect(pending[0]!.request.workspaceId).toBe("w");

    const submitted = await client.callTool({
      name: "submit_semantic_review",
      arguments: {
        requestId: pending[0]!.requestId,
        classification: "compatible",
        confidence: 0.9,
        affectedSymbols: [],
        evidence: ["reviewed via MCP"],
        invariantsToPreserve: [],
        requiresHumanApproval: false
      }
    });
    expect(JSON.parse((submitted.content as Array<{ type: string; text: string }>)[0]!.text)).toEqual({ ok: true });

    const reviewResponse = await reviewPromise;
    expect(reviewResponse.status).toBe(201);
    const { data: record } = await reviewResponse.json();
    expect(record.classification).toBe("compatible");
    expect(running.daemon.listSemanticReviewsFor(operation.id)).toEqual([record]);
  }, 20_000);
});
