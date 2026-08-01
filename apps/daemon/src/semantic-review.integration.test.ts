import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationService } from "../../service/src/index.js";
import { AgentDelegatedReviewer, contentHash, MockSemanticReviewer, type SemanticReview } from "@crosscode/core";
import { LocalDaemon, startDaemon } from "./index.js";

const exec = promisify(execFile); const directories: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];
async function repo(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "crosscode-daemon-review-"));
  directories.push(path);
  await exec("git", ["init", "-q", "-b", "main", path]);
  await exec("git", ["-C", path, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", path, "config", "user.name", "Test"]);
  await writeFile(join(path, "a.txt"), "one\n");
  await mkdir(join(path, ".crosscode"), { recursive: true });
  await writeFile(join(path, ".crosscode", "config.yaml"),
    "version: 1\nvalidation:\n  profiles:\n    fast:\n      commands:\n        - node --version\naiReview:\n  externalAiReview: approved\n  allowedProviders:\n    - mock-provider\n  requireLocalConfirmation: true\n");
  await exec("git", ["-C", path, "add", "."]);
  await exec("git", ["-C", path, "commit", "-qm", "initial"]);
  return path;
}
async function repoWithDisabledReview(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "crosscode-daemon-review-disabled-"));
  directories.push(path);
  await exec("git", ["init", "-q", "-b", "main", path]);
  await exec("git", ["-C", path, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", path, "config", "user.name", "Test"]);
  await writeFile(join(path, "a.txt"), "one\n");
  await mkdir(join(path, ".crosscode"), { recursive: true });
  await writeFile(join(path, ".crosscode", "config.yaml"), "version: 1\nvalidation:\n  profiles:\n    fast:\n      commands:\n        - node --version\n");
  await exec("git", ["-C", path, "add", "."]);
  await exec("git", ["-C", path, "commit", "-qm", "initial"]);
  return path;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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

describe("AI semantic reviewer", () => {
  it("requests a review only for a deterministically ambiguous (likely-compatible) proposal, and rejects it for independent/critical paths", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const reviewer = new MockSemanticReviewer();
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b", reviewer });
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" });
    await writeFile(join(senderRoot, "b.txt"), "new\n");
    await exec("git", ["-C", senderRoot, "add", "b.txt"]);
    const independentOperation = await sender.capture("add file", service);
    await receiver.sync(service);
    await expect(receiver.requestSemanticReview(independentOperation.id, "b.txt", "mock-provider")).rejects.toThrow("not eligible");
  });

  it("refuses to call a reviewer when workspace policy disables external AI review", async () => {
    const senderRoot = await repoWithDisabledReview(); const receiverRoot = await repoWithDisabledReview(); const service = new CoordinationService();
    const reviewer = new MockSemanticReviewer();
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b", reviewer });
    const operation = await likelyCompatibleProposal(senderRoot, receiverRoot, service, receiver);
    await expect(receiver.requestSemanticReview(operation.id, "a.txt", "mock-provider")).rejects.toThrow("disabled");
  });

  it("refuses a reviewer that is not on the workspace allow list", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const reviewer = new MockSemanticReviewer();
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b", reviewer });
    const operation = await likelyCompatibleProposal(senderRoot, receiverRoot, service, receiver);
    await expect(receiver.requestSemanticReview(operation.id, "a.txt", "unlisted-provider")).rejects.toThrow("allow list");
  });

  it("stores a schema-validated audit record and lets an explicitly human-approved review unblock materialization through the ordinary accept flow", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const reviewer = new MockSemanticReviewer();
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b", reviewer });
    const operation = await likelyCompatibleProposal(senderRoot, receiverRoot, service, receiver);
    reviewer.queueResponseFor(operation.id, { classification: "compatible", confidence: 0.9, affectedSymbols: [], evidence: ["no overlapping behavior"], invariantsToPreserve: [], requiresHumanApproval: false });

    const record = await receiver.requestSemanticReview(operation.id, "a.txt", "mock-provider");
    expect(record.classification).toBe("compatible");
    expect(record.decision).toBe("pending");
    expect(receiver.listSemanticReviewsFor(operation.id)).toEqual([record]);

    // Reviews are non-authoritative: they can never materialize a write by themselves.
    await expect(receiver.accept(operation.id)).rejects.toThrow("requires local human approval");
    expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe("one\n");

    const approved = await receiver.resolveSemanticReview(record.id, "accepted");
    expect(approved.decision).toBe("accepted");
    // Approving the review is audit-only too -- still no materialization until accept() runs.
    expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe("one\n");

    const accepted = await receiver.accept(operation.id, { reviewApprovals: { "a.txt": record.id } });
    expect(accepted.status).toBe("accepted");
    expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe("sender-edit\n");
  });

  it("leaves the working tree and Git state unchanged after a human rejects the review", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const reviewer = new MockSemanticReviewer();
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b", reviewer });
    const operation = await likelyCompatibleProposal(senderRoot, receiverRoot, service, receiver);
    reviewer.queueResponseFor(operation.id, { classification: "compatible", confidence: 0.95, affectedSymbols: [], evidence: [], invariantsToPreserve: [], requiresHumanApproval: false });
    const record = await receiver.requestSemanticReview(operation.id, "a.txt", "mock-provider");

    const headBefore = await exec("git", ["-C", receiverRoot, "rev-parse", "HEAD"]).then((r) => r.stdout.trim());
    const rejected = await receiver.resolveSemanticReview(record.id, "rejected");
    expect(rejected.decision).toBe("rejected");

    await expect(receiver.accept(operation.id, { reviewApprovals: { "a.txt": record.id } })).rejects.toThrow("requires local human approval");
    expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe("one\n");
    expect(await exec("git", ["-C", receiverRoot, "rev-parse", "HEAD"]).then((r) => r.stdout.trim())).toBe(headBefore);
    expect(await exec("git", ["-C", receiverRoot, "status", "--porcelain"]).then((r) => r.stdout.trim())).toBe("");
  });

  it("treats a stale approval (base drifted since review) as invalid and still refuses to materialize", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const reviewer = new MockSemanticReviewer();
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b", reviewer });
    const operation = await likelyCompatibleProposal(senderRoot, receiverRoot, service, receiver);
    reviewer.queueResponseFor(operation.id, { classification: "compatible", confidence: 0.9, affectedSymbols: [], evidence: [], invariantsToPreserve: [], requiresHumanApproval: false });
    const record = await receiver.requestSemanticReview(operation.id, "a.txt", "mock-provider");
    await receiver.resolveSemanticReview(record.id, "accepted");

    // Local work changes after the review was approved -- the approval must not silently carry over.
    await writeFile(join(receiverRoot, "a.txt"), "receiver-edit-2\n");
    await expect(receiver.accept(operation.id, { reviewApprovals: { "a.txt": record.id } })).rejects.toThrow();
  });

  it("treats malformed provider output as uncertain, forces human approval, and never records or forwards a patch", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const reviewer = new MockSemanticReviewer(new Map(), () => ({ classification: "definitely-not-valid" as unknown as SemanticReview["classification"], confidence: 5, affectedSymbols: [], evidence: [], invariantsToPreserve: [], proposedResolution: { explanation: "x", patch: "rm -rf /" }, requiresHumanApproval: false }));
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b", reviewer });
    const operation = await likelyCompatibleProposal(senderRoot, receiverRoot, service, receiver);
    const record = await receiver.requestSemanticReview(operation.id, "a.txt", "mock-provider");
    expect(record.response.classification).toBe("uncertain");
    expect(record.response.requiresHumanApproval).toBe(true);
    expect(record.response.proposedResolution).toBeUndefined();
  });

  it("forces requiresHumanApproval for high-risk (semantic-overlap) reviews regardless of provider confidence, and only ever writes an audit record with hashes/reasons, never secret values", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const reviewer = new MockSemanticReviewer();
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b", reviewer });
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" });
    await writeFile(join(senderRoot, "lib.ts"), "export function greet(name: string) { return `hi ${name}`; }\n");
    await exec("git", ["-C", senderRoot, "add", "lib.ts"]); await exec("git", ["-C", senderRoot, "commit", "-qm", "add lib"]);
    await writeFile(join(receiverRoot, "lib.ts"), "export function greet(name: string) { return `hi ${name}`; }\n");
    await exec("git", ["-C", receiverRoot, "add", "lib.ts"]); await exec("git", ["-C", receiverRoot, "commit", "-qm", "add lib"]);

    const senderReopened = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" });
    const secretLine = "const password: 'do-not-leak-this-value' = 'do-not-leak-this-value';\n";
    await writeFile(join(senderRoot, "lib.ts"), `export function greet(name: string, greeting: string) { return greeting + name; }\n${secretLine}`);
    const operation = await senderReopened.capture("rename param", service);
    await receiver.sync(service);
    const overlappingChange = { path: "lib.ts", kind: "modify" as const, beforeHash: contentHash("export function greet(name: string) { return `hi ${name}`; }\n"), afterHash: contentHash("export function greet(name: string) { return `yo ${name}`; }\n"), afterContent: "export function greet(name: string) { return `yo ${name}`; }\n" };
    const pendingLocal = { id: "fake-local-lib", workspaceId: "w", senderReplicaId: "receiver", transaction: { id: "fake-local-lib", base: { files: [] }, changes: [overlappingChange], provenance: { source: "filesystem" as const, confidence: "known" as const }, safety: { risk: "low" as const, requiresApproval: false } }, sequence: 1, createdAt: new Date().toISOString(), status: "local" as const };
    receiver.operations.set(pendingLocal.id, pendingLocal);

    reviewer.queueResponseFor(operation.id, { classification: "behavior_changed", confidence: 0.99, affectedSymbols: ["greet"], evidence: ["signature changed"], invariantsToPreserve: [], requiresHumanApproval: false });
    const record = await receiver.requestSemanticReview(operation.id, "lib.ts", "mock-provider");
    expect(record.requestedRisk).toBe("high");
    expect(record.response.requiresHumanApproval).toBe(true);
    expect(record.redactions.some((r) => r.reason === "secret-content")).toBe(true);

    const statePath = join(receiverRoot, ".git", "crosscode", "state.sqlite");
    const database = new DatabaseSync(statePath, { readOnly: true });
    const rows = database.prepare("SELECT payload FROM semantic_review WHERE id = ?").all(record.id) as Array<{ payload: string }>;
    const eventRows = database.prepare("SELECT payload FROM local_events WHERE type = 'semantic_review.requested'").all() as Array<{ payload: string }>;
    database.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).not.toContain("do-not-leak-this-value");
    eventRows.forEach((row) => expect(row.payload).not.toContain("do-not-leak-this-value"));
  });
});

describe("agent-delegated semantic review over the local HTTP API", () => {
  it("shows an ambiguous proposal as pending and reflects the agent's submitted review through the ordinary accept flow", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const running = await startDaemon(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b", reviewer: new AgentDelegatedReviewer() });
    servers.push(running);
    const operation = await likelyCompatibleProposal(senderRoot, receiverRoot, service, running.daemon);
    const url = `http://127.0.0.1:${running.port}`;
    const authorization = `Bearer ${running.secret}`;

    const requestPromise = fetch(`${url}/v1/operations/${operation.id}/reviews`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ path: "a.txt", providerId: "mock-provider" })
    });

    let pending: Array<{ requestId: string; requestedAt: string }> = [];
    for (let attempt = 0; attempt < 50 && pending.length === 0; attempt += 1) {
      const pendingResponse = await fetch(`${url}/v1/semantic-reviews/pending`, { headers: { authorization } });
      ({ data: pending } = await pendingResponse.json());
      if (pending.length === 0) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    expect(pending).toHaveLength(1);

    const submitResponse = await fetch(`${url}/v1/semantic-reviews/${pending[0]!.requestId}/submit`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ classification: "compatible", confidence: 0.9, affectedSymbols: [], evidence: ["agent reviewed it"], invariantsToPreserve: [], requiresHumanApproval: false })
    });
    expect(submitResponse.status).toBe(200);
    expect(await submitResponse.json()).toEqual({ ok: true, data: { ok: true } });

    const requestResponse = await requestPromise;
    expect(requestResponse.status).toBe(201);
    const { data: record } = await requestResponse.json();
    expect(record.classification).toBe("compatible");
    expect(record.decision).toBe("pending");

    const afterSubmitPending = await (await fetch(`${url}/v1/semantic-reviews/pending`, { headers: { authorization } })).json();
    expect(afterSubmitPending.data).toEqual([]);

    const approved = await running.daemon.resolveSemanticReview(record.id, "accepted");
    expect(approved.decision).toBe("accepted");
    const accepted = await running.daemon.accept(operation.id, { reviewApprovals: { "a.txt": record.id } });
    expect(accepted.status).toBe("accepted");
    expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe("sender-edit\n");
  });

  it("falls back to the safe uncertain/requiresHumanApproval behavior when the agent never submits before the timeout", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const running = await startDaemon(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b", reviewer: new AgentDelegatedReviewer({ timeoutMs: 20 }) });
    servers.push(running);
    const operation = await likelyCompatibleProposal(senderRoot, receiverRoot, service, running.daemon);
    const url = `http://127.0.0.1:${running.port}`;
    const authorization = `Bearer ${running.secret}`;

    const requestResponse = await fetch(`${url}/v1/operations/${operation.id}/reviews`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ path: "a.txt", providerId: "mock-provider" })
    });
    expect(requestResponse.status).toBe(201);
    const { data: record } = await requestResponse.json();
    expect(record.classification).toBe("uncertain");
    expect(record.response.requiresHumanApproval).toBe(true);

    const pendingResponse = await fetch(`${url}/v1/semantic-reviews/pending`, { headers: { authorization } });
    expect((await pendingResponse.json()).data).toEqual([]);
  });
});
