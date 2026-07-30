import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationService } from "../../service/src/index.js";
import { MockSemanticReviewer, type SemanticReview } from "@crosscode/core";
import { LocalDaemon, startDaemon, type RemoteSyncTransport } from "./index.js";

const exec = promisify(execFile);
const directories: string[] = [];
async function git(root: string, args: string[]): Promise<string> { return (await exec("git", ["-C", root, ...args])).stdout.trim(); }

// A shared API type (single-line, so the textual interface-change heuristic in
// `@crosscode/core`'s `looksLikeInterfaceChange` can see the exported declaration change)
// and a client call that depends on it, plus a test fixture -- the three files the
// three participants of BUILD_INSTRUCTIONS.md section 19's fixture edit concurrently.
const typesFile = "export type ApiRequest = { id: string };\n";
const clientFile = "import type { ApiRequest } from \"./types.js\";\n\nexport function callApi(request: ApiRequest): Promise<Response> {\n  return fetch(\"/api\", { method: \"POST\", body: JSON.stringify(request) });\n}\n";
const fixtureFile = "export const sampleRequest = { id: \"abc\" };\n";

async function seedWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crosscode-e2e-"));
  directories.push(root);
  const seed = join(root, "seed");
  await exec("git", ["init", "-q", "-b", "main", seed]);
  await git(seed, ["config", "user.email", "test@example.com"]);
  await git(seed, ["config", "user.name", "Test"]);
  await mkdir(join(seed, "src"), { recursive: true });
  await mkdir(join(seed, "test"), { recursive: true });
  await mkdir(join(seed, ".crosscode"), { recursive: true });
  await writeFile(join(seed, "src", "types.ts"), typesFile);
  await writeFile(join(seed, "src", "client.ts"), clientFile);
  await writeFile(join(seed, "test", "fixture.test.ts"), fixtureFile);
  await writeFile(join(seed, ".crosscode", "config.yaml"),
    "version: 1\nvalidation:\n  profiles:\n    fast:\n      commands:\n        - node --version\naiReview:\n  externalAiReview: approved\n  allowedProviders:\n    - mock-provider\n  requireLocalConfirmation: true\n");
  await exec("git", ["-C", seed, "add", "."]);
  await exec("git", ["-C", seed, "commit", "-qm", "initial"]);
  for (const name of ["cursor", "codex", "claude-code"]) {
    const clone = join(root, name);
    await exec("git", ["clone", "-q", seed, clone]);
    await git(clone, ["config", "user.email", "test@example.com"]);
    await git(clone, ["config", "user.name", "Test"]);
  }
  return root;
}

afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("three-participant end-to-end fixture (BUILD_INSTRUCTIONS.md section 19 / Milestone C acceptance)", () => {
  it("Cursor claims frontend and edits a client call, Codex changes a shared API type, and Claude Code updates a test fixture: the interface impact is detected and never silently merged, independent work materializes without loss, and accepted work is validated, checkpointed, and published as a normal commit on a test remote", async () => {
    const root = await seedWorkspace();
    const cursorRoot = join(root, "cursor"); const codexRoot = join(root, "codex"); const claudeRoot = join(root, "claude-code");
    const service = new CoordinationService();
    const cursor = await LocalDaemon.open(cursorRoot, { workspaceId: "w", replicaId: "cursor", actorId: "cursor-user" });
    const codex = await LocalDaemon.open(codexRoot, { workspaceId: "w", replicaId: "codex", actorId: "codex-user" });
    const claudeCode = await LocalDaemon.open(claudeRoot, { workspaceId: "w", replicaId: "claude-code", actorId: "claude-code-user" });

    // 1. "Cursor" claims the frontend path and modifies a client call.
    const task = await cursor.createTask({ title: "Update the API client call" });
    const claim = await cursor.createClaim({ taskId: task.id, kind: "path", target: "src/client.ts", mode: "exclusive-preferred" });
    expect(claim.target).toBe("src/client.ts");
    const cursorClientEdit = clientFile.replace("method: \"POST\"", "method: \"POST\", headers: { \"content-type\": \"application/json\" }");
    await writeFile(join(cursorRoot, "src", "client.ts"), cursorClientEdit);
    const cursorOp = await cursor.capture("Add a JSON content-type header to the client call", service);

    // 2. "Codex" changes a shared API type.
    const codexTypesEdit = "export type ApiRequest = { id: string; token: string };\n";
    await writeFile(join(codexRoot, "src", "types.ts"), codexTypesEdit);
    const codexOp = await codex.capture("Add a required auth token to ApiRequest", service);

    // 3. "Claude Code" updates a test fixture.
    const claudeFixtureEdit = "export const sampleRequest = { id: \"abc\", token: \"test-token\" };\n";
    await writeFile(join(claudeRoot, "test", "fixture.test.ts"), claudeFixtureEdit);
    const claudeOp = await claudeCode.capture("Update the fixture to include the new token field", service);

    // Everyone syncs and now sees the other two participants' work as proposals.
    await cursor.sync(service); await codex.sync(service); await claudeCode.sync(service);
    expect([...cursor.operations.values()].filter((op) => op.status === "proposed").map((op) => op.id).sort()).toEqual([codexOp.id, claudeOp.id].sort());
    expect([...codex.operations.values()].filter((op) => op.status === "proposed").map((op) => op.id).sort()).toEqual([cursorOp.id, claudeOp.id].sort());
    expect([...claudeCode.operations.values()].filter((op) => op.status === "proposed").map((op) => op.id).sort()).toEqual([cursorOp.id, codexOp.id].sort());

    // 4. The system detects the interface impact of Codex's type change on Cursor's dependent client call.
    const diffOnCursor = await cursor.diffProposal(codexOp.id);
    expect(diffOnCursor.find((entry) => entry.path === "src/types.ts")).toMatchObject({ classification: "interface-impact", risk: "high", requiresApproval: true, dependents: ["src/client.ts"] });
    await expect(cursor.accept(codexOp.id)).rejects.toThrow("requires local human approval");
    // An ambiguous interface change is never silently auto-resolved or materialized.
    expect(await readFile(join(cursorRoot, "src", "types.ts"), "utf8")).toBe(typesFile);
    expect(cursor.operations.get(codexOp.id)?.status).toBe("proposed");

    // 5. Accepted (non-conflicting) changes materialize without deleting either party's independent work.
    await cursor.accept(claudeOp.id);
    await codex.accept(claudeOp.id);
    await codex.accept(cursorOp.id);
    await claudeCode.accept(cursorOp.id);

    expect(await readFile(join(cursorRoot, "src", "client.ts"), "utf8")).toBe(cursorClientEdit);
    expect(await readFile(join(cursorRoot, "test", "fixture.test.ts"), "utf8")).toBe(claudeFixtureEdit);
    expect(await readFile(join(codexRoot, "src", "types.ts"), "utf8")).toBe(codexTypesEdit);
    expect(await readFile(join(codexRoot, "src", "client.ts"), "utf8")).toBe(cursorClientEdit);
    expect(await readFile(join(codexRoot, "test", "fixture.test.ts"), "utf8")).toBe(claudeFixtureEdit);
    expect(await readFile(join(claudeRoot, "test", "fixture.test.ts"), "utf8")).toBe(claudeFixtureEdit);
    expect(await readFile(join(claudeRoot, "src", "client.ts"), "utf8")).toBe(cursorClientEdit);

    // 6. Validation runs, a hidden checkpoint exists, and publish creates a normal commit on a test remote.
    const headBefore = await git(claudeRoot, ["rev-parse", "HEAD"]);
    const branchBefore = await git(claudeRoot, ["branch", "--show-current"]);
    const [validation] = await claudeCode.validate("fast", ["true"]);
    expect(validation!.exitCode).toBe(0);
    expect(claudeCode.checkpoints.length).toBeGreaterThan(0);
    expect(await git(claudeRoot, ["for-each-ref", "refs/crosscode/checkpoints"])).not.toBe("");
    expect(await git(claudeRoot, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await git(claudeRoot, ["branch", "--show-current"])).toBe(branchBefore);

    const bareRemote = join(root, "origin.git");
    await exec("git", ["init", "-q", "--bare", bareRemote]);
    await git(claudeRoot, ["remote", "set-url", "origin", bareRemote]);
    const publishResult = await claudeCode.publish({ branch: "main", profile: "fast", message: "Crosscode: merge accepted changes" });
    if (!("commit" in publishResult)) throw new Error("Expected a completed publish result");
    expect(publishResult.previous).toBe(headBefore);
    await git(claudeRoot, ["push", "-q", "origin", "main"]);

    expect(await git(bareRemote, ["rev-parse", "main"])).toBe(publishResult.commit);
    expect(await git(bareRemote, ["log", "-1", "--format=%P", "main"])).toBe(headBefore);
    expect(await git(bareRemote, ["show", "main:test/fixture.test.ts"])).toBe(claudeFixtureEdit.trim());
    expect(await git(bareRemote, ["show", "main:src/client.ts"])).toBe(cursorClientEdit.trim());
    // Publishing never disturbs the checked-out branch, HEAD, or an unrelated file.
    await writeFile(join(claudeRoot, "unrelated.txt"), "leave me alone\n");
    expect(await git(claudeRoot, ["branch", "--show-current"])).toBe(branchBefore);
    expect(await readFile(join(claudeRoot, "unrelated.txt"), "utf8")).toBe("leave me alone\n");
  }, 20_000);

  it("never silently merges concurrent edits to the same symbol: two independent proposals for the same line land on an untouched third participant and neither materializes without approval", async () => {
    const root = await seedWorkspace();
    const cursorRoot = join(root, "cursor"); const codexRoot = join(root, "codex"); const claudeRoot = join(root, "claude-code");
    const service = new CoordinationService();
    const cursor = await LocalDaemon.open(cursorRoot, { workspaceId: "w", replicaId: "cursor", actorId: "cursor-user" });
    const codex = await LocalDaemon.open(codexRoot, { workspaceId: "w", replicaId: "codex", actorId: "codex-user" });
    const claudeCode = await LocalDaemon.open(claudeRoot, { workspaceId: "w", replicaId: "claude-code", actorId: "claude-code-user" });

    await writeFile(join(cursorRoot, "src", "client.ts"), clientFile.replace("/api", "/api/v2"));
    const cursorOp = await cursor.capture("Point the client at /api/v2", service);
    await writeFile(join(codexRoot, "src", "client.ts"), clientFile.replace("/api", "/api/v3"));
    const codexOp = await codex.capture("Point the client at /api/v3", service);

    // Claude Code never touched client.ts locally, but receives both conflicting proposals.
    await claudeCode.sync(service);
    const diff = await claudeCode.diffProposal(cursorOp.id);
    expect(diff.find((entry) => entry.path === "src/client.ts")).toMatchObject({ classification: "likely-compatible", risk: "medium", requiresApproval: true });

    await expect(claudeCode.accept(cursorOp.id)).rejects.toThrow("requires local human approval");
    expect(await readFile(join(claudeRoot, "src", "client.ts"), "utf8")).toBe(clientFile);
    expect(claudeCode.operations.get(cursorOp.id)?.status).toBe("proposed");
    expect(claudeCode.operations.get(codexOp.id)?.status).toBe("proposed");
  }, 30_000);

  it("never silently overwrites a delete-vs-modify collision: a deletion and a modification of the same file both land on an untouched third participant", async () => {
    const root = await seedWorkspace();
    const cursorRoot = join(root, "cursor"); const codexRoot = join(root, "codex"); const claudeRoot = join(root, "claude-code");
    const service = new CoordinationService();
    const cursor = await LocalDaemon.open(cursorRoot, { workspaceId: "w", replicaId: "cursor", actorId: "cursor-user" });
    const codex = await LocalDaemon.open(codexRoot, { workspaceId: "w", replicaId: "codex", actorId: "codex-user" });
    const claudeCode = await LocalDaemon.open(claudeRoot, { workspaceId: "w", replicaId: "claude-code", actorId: "claude-code-user" });

    await rm(join(codexRoot, "test", "fixture.test.ts"));
    const deleteOp = await codex.capture("Remove the obsolete fixture", service);
    await writeFile(join(claudeRoot, "test", "fixture.test.ts"), "export const sampleRequest = { id: \"abc\", extra: true };\n");
    const modifyOp = await claudeCode.capture("Extend the fixture", service);

    await cursor.sync(service);
    const diff = await cursor.diffProposal(deleteOp.id);
    expect(diff.find((entry) => entry.path === "test/fixture.test.ts")).toMatchObject({ classification: "delete-vs-modify", risk: "high", requiresApproval: true });

    await expect(cursor.accept(deleteOp.id)).rejects.toThrow("requires local human approval");
    expect(await readFile(join(cursorRoot, "test", "fixture.test.ts"), "utf8")).toBe(fixtureFile);
    expect(cursor.operations.get(deleteOp.id)?.status).toBe("proposed");
    expect(cursor.operations.get(modifyOp.id)?.status).toBe("proposed");
  }, 30_000);

  it("pauses materialization after a git reset instead of applying a pending proposal against reset-away state, and recovers once re-analyzed", async () => {
    const root = await seedWorkspace();
    const cursorRoot = join(root, "cursor"); const codexRoot = join(root, "codex");
    const service = new CoordinationService();
    const cursor = await LocalDaemon.open(cursorRoot, { workspaceId: "w", replicaId: "cursor", actorId: "cursor-user" });
    const codex = await LocalDaemon.open(codexRoot, { workspaceId: "w", replicaId: "codex", actorId: "codex-user" });

    await writeFile(join(codexRoot, "src", "types.ts"), "export type ApiRequest = { id: string; extra: boolean };\n");
    const codexOp = await codex.capture("Widen ApiRequest", service);
    await cursor.sync(service);

    await writeFile(join(cursorRoot, "uncommitted.txt"), "dirty\n");
    await exec("git", ["-C", cursorRoot, "reset", "--hard", "HEAD"]);

    await expect(cursor.observeGitTransition()).resolves.toMatchObject({ kind: "reset", paused: true });
    await expect(cursor.accept(codexOp.id)).rejects.toThrow("paused");
    expect(await readFile(join(cursorRoot, "src", "types.ts"), "utf8")).toBe(typesFile);

    const reanalyzed = await cursor.reanalyzePendingOperations();
    expect(reanalyzed.find((op) => op.id === codexOp.id)?.status).toBe("proposed");
    const status = await cursor.status();
    expect(status.materializationPaused).toBe(false);
  }, 30_000);

  it("rejects an invalid operation payload at the real daemon's HTTP boundary instead of queuing or materializing it", async () => {
    const root = await seedWorkspace();
    const cursorRoot = join(root, "cursor");
    const running = await startDaemon(cursorRoot, { workspaceId: "w", replicaId: "cursor", actorId: "cursor-user" });
    try {
      const response = await fetch(`http://127.0.0.1:${running.port}/v1/transactions`, {
        method: "POST",
        headers: { authorization: `Bearer ${running.secret}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "intent" }) // missing the required "intent" text field
      });
      const body = await response.json() as { ok: boolean; error?: string };
      expect(response.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(running.daemon.operations.size).toBe(0);
    } finally {
      await running.close();
    }
  }, 30_000);

  it("survives lost connectivity: offline work is durably queued, a failed sync leaves it queued without duplication, and a later successful sync uploads it exactly once", async () => {
    const root = await seedWorkspace();
    const cursorRoot = join(root, "cursor");
    let cursor = await LocalDaemon.open(cursorRoot, { workspaceId: "w", replicaId: "cursor", actorId: "cursor-user" });
    await writeFile(join(cursorRoot, "src", "client.ts"), clientFile.replace("/api", "/api/offline"));
    const offlineOp = await cursor.capture("Point the client at /api/offline");
    cursor.close();

    // Restart to prove the offline event survived a daemon restart while disconnected.
    cursor = await LocalDaemon.open(cursorRoot, { workspaceId: "w", replicaId: "cursor", actorId: "cursor-user" });
    expect(cursor.outbound.get(offlineOp.id)?.acknowledgedServerSequence).toBeUndefined();
    cursor.configureRemoteSync();

    const unreachable = new Error("Connection refused: coordination service is unreachable");
    const failingTransport = {
      upload: () => Promise.reject(unreachable), list: () => Promise.reject(unreachable),
      uploadTask: () => Promise.reject(unreachable), listTasks: (after: string) => Promise.resolve({ tasks: [], nextCursor: after }),
      uploadClaim: () => Promise.reject(unreachable), listClaims: (after: string) => Promise.resolve({ claims: [], nextCursor: after }),
      uploadHandoff: () => Promise.reject(unreachable), listHandoffs: (after: string) => Promise.resolve({ handoffs: [], nextCursor: after }),
      uploadIntent: () => Promise.reject(unreachable), listIntents: (after: string) => Promise.resolve({ intents: [], nextCursor: after }),
      uploadValidation: () => Promise.reject(unreachable), listValidations: (after: string) => Promise.resolve({ validations: [], nextCursor: after })
    };
    await expect(cursor.syncRemote(failingTransport)).rejects.toThrow(/unreachable/);
    cursor.recordRemoteSyncFailure();
    expect((await cursor.status()).service).toMatchObject({ online: false });
    expect((await cursor.status()).pendingOutbound).toBe(1);

    const uploaded: string[] = [];
    const recoveredTransport: RemoteSyncTransport = {
      upload: async (record) => { uploaded.push(record.transaction.id); return { id: record.transaction.id, workspaceId: "w", senderReplicaId: "cursor", transaction: record.transaction, sequence: 1, createdAt: new Date().toISOString() }; },
      list: async () => ({ operations: [], nextCursor: 0 }),
      uploadTask: async (record) => ({ eventId: record.event.id, workspaceId: "w", senderReplicaId: "cursor", task: record.event.payload, updatedAt: new Date().toISOString() }),
      listTasks: async (after) => ({ tasks: [], nextCursor: after }),
      uploadClaim: async (record) => ({ eventId: record.event.id, workspaceId: "w", senderReplicaId: "cursor", claim: record.event.payload, released: false, updatedAt: new Date().toISOString() }),
      listClaims: async (after) => ({ claims: [], nextCursor: after }),
      uploadHandoff: async (record) => ({ eventId: record.event.id, workspaceId: "w", senderReplicaId: "cursor", handoff: record.event.payload, updatedAt: new Date().toISOString() }),
      listHandoffs: async (after) => ({ handoffs: [], nextCursor: after }),
      uploadIntent: async (record) => ({ eventId: record.event.id, workspaceId: "w", senderReplicaId: "cursor", intent: record.event.payload, updatedAt: new Date().toISOString() }),
      listIntents: async (after) => ({ intents: [], nextCursor: after }),
      uploadValidation: async (record) => ({ eventId: record.event.id, workspaceId: "w", senderReplicaId: "cursor", validation: record.event.payload, createdAt: new Date().toISOString() }),
      listValidations: async (after) => ({ validations: [], nextCursor: after })
    };
    const result = await cursor.syncRemote(recoveredTransport);
    expect(result.uploaded).toBe(1);
    expect(uploaded).toEqual([offlineOp.id]);
    expect((await cursor.status()).pendingOutbound).toBe(0);

    // Retrying sync again must not re-upload the already-acknowledged event.
    const secondPass = await cursor.syncRemote(recoveredTransport);
    expect(secondPass.uploaded).toBe(0);
    expect(uploaded).toEqual([offlineOp.id]);
  }, 30_000);

  it("treats malformed or unsafe semantic reviewer output as uncertain, forces human approval, and never lets it bypass materialization", async () => {
    const root = await seedWorkspace();
    const cursorRoot = join(root, "cursor"); const codexRoot = join(root, "codex"); const claudeRoot = join(root, "claude-code");
    const service = new CoordinationService();
    const unsafeReviewer = new MockSemanticReviewer(new Map(), () => ({
      classification: "definitely-not-a-real-classification" as unknown as SemanticReview["classification"],
      confidence: 999, affectedSymbols: [], evidence: [], invariantsToPreserve: [],
      proposedResolution: { explanation: "trust me", patch: "rm -rf /" },
      requiresHumanApproval: false
    }));
    const cursor = await LocalDaemon.open(cursorRoot, { workspaceId: "w", replicaId: "cursor", actorId: "cursor-user" });
    const codex = await LocalDaemon.open(codexRoot, { workspaceId: "w", replicaId: "codex", actorId: "codex-user" });
    const claudeCode = await LocalDaemon.open(claudeRoot, { workspaceId: "w", replicaId: "claude-code", actorId: "claude-code-user", reviewer: unsafeReviewer });

    await writeFile(join(cursorRoot, "src", "client.ts"), clientFile.replace("/api", "/api/v2"));
    const cursorOp = await cursor.capture("Point the client at /api/v2", service);
    await writeFile(join(codexRoot, "src", "client.ts"), clientFile.replace("/api", "/api/v3"));
    await codex.capture("Point the client at /api/v3", service);
    await claudeCode.sync(service);

    const record = await claudeCode.requestSemanticReview(cursorOp.id, "src/client.ts", "mock-provider");
    expect(record.response.classification).toBe("uncertain");
    expect(record.response.requiresHumanApproval).toBe(true);
    expect(record.response.proposedResolution).toBeUndefined();

    // The malformed review can never satisfy approval, and the unsafe patch was never written anywhere.
    await expect(claudeCode.accept(cursorOp.id, { reviewApprovals: { "src/client.ts": record.id } })).rejects.toThrow("requires local human approval");
    expect(await readFile(join(claudeRoot, "src", "client.ts"), "utf8")).toBe(clientFile);
    await expect(git(claudeRoot, ["status", "--porcelain"])).resolves.toBe("");
  }, 30_000);
});
